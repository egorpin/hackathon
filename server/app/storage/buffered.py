"""Coalesce detached world drafts and commit them outside the ASGI event loop."""
import logging
import time
from threading import Condition, Thread


logger = logging.getLogger(__name__)


class BufferedGameWriter:
    def __init__(self, db, interval=1.0):
        if interval <= 0:
            raise ValueError('Flush interval must be positive')
        self.db = db
        self.interval = interval
        self._condition = Condition()
        self._pending = {}
        self._version = 0
        self._written = 0
        self._force = False
        self._stopping = False
        self._error = None
        self._failures = 0
        self._thread = Thread(target=self._run, name='game-sqlite-writer', daemon=True)
        self._thread.start()

    def submit(self, state):
        # UnitOfWork transfers ownership of an already detached draft.
        with self._condition:
            if self._stopping or not self._thread.is_alive():
                raise RuntimeError('Game writer is closed')
            self._version += 1
            self._pending[state.world_id] = (self._version, state)
            self._condition.notify_all()

    def flush(self):
        """Wait until all drafts submitted before this call have committed."""
        with self._condition:
            target, failures = self._version, self._failures
            self._force = True
            self._condition.notify_all()
            while self._written < target:
                if self._failures != failures:
                    raise RuntimeError('Could not flush game state') from self._error
                if not self._thread.is_alive():
                    raise RuntimeError('Game writer stopped') from self._error
                self._condition.wait()

    def close(self):
        with self._condition:
            self._stopping = True
            self._condition.notify_all()
        self._thread.join()
        if self._error is not None:
            raise RuntimeError('Final game state flush failed') from self._error

    def _run(self):
        known_commands = {}
        try:
            # This connection belongs exclusively to the writer thread.
            with self.db.connect() as connection:
                deadline = time.monotonic() + self.interval
                while True:
                    with self._condition:
                        while not self._stopping and not self._force and time.monotonic() < deadline:
                            self._condition.wait(max(0, deadline - time.monotonic()))
                        batch, self._pending = self._pending, {}
                        self._force = False
                        stopping = self._stopping
                    if batch:
                        try:
                            self.db.save_game_batch(connection, [state for _, state in batch.values()], known_commands)
                        except Exception as error:
                            logger.exception('Game state batch failed; retaining latest drafts for retry')
                            with self._condition:
                                for world_id, item in batch.items():
                                    self._pending.setdefault(world_id, item)
                                self._error = error
                                self._failures += 1
                                self._condition.notify_all()
                            if stopping:
                                return
                        else:
                            with self._condition:
                                self._written = max(version for version, _ in batch.values())
                                self._error = None
                                self._condition.notify_all()
                    if stopping:
                        return
                    deadline = time.monotonic() + self.interval
        except Exception as error:
            logger.exception('Game state writer stopped unexpectedly')
            with self._condition:
                self._error = error
                self._failures += 1
                self._condition.notify_all()
