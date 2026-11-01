"""State-machine tests: no host networking, firewall or certificate changes."""
import importlib.util
from pathlib import Path
import threading

import pytest

spec = importlib.util.spec_from_file_location("mars_mdns", Path(__file__).with_name("mars-mdns.py"))
mdns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mdns)


def test_select_adapter_and_reject_ambiguity():
    rows = [{"name": "Wi-Fi", "address": "192.168.1.10"},
            {"name": "Ethernet", "address": "10.0.0.2"}]
    with pytest.raises(ValueError, match="Select one"):
        mdns.select_interface(rows)
    assert mdns.select_interface(rows, "wi-fi") == ("Wi-Fi", ("192.168.1.10",))
    with pytest.raises(ValueError):
        mdns.select_interface(rows, "missing")


def test_dhcp_change_disconnect_and_reconnect_withdraw_old_records():
    stop = threading.Event()
    events = []
    snapshots = iter([
        [{"name": "Wi-Fi", "address": "192.168.1.10"}],
        [{"name": "Wi-Fi", "address": "192.168.1.10"}],
        [{"name": "Wi-Fi", "address": "172.20.10.2"}],
        [],
        [{"name": "Wi-Fi", "address": "172.20.10.3"}],
    ])

    def discover():
        try:
            return next(snapshots)
        except StopIteration:
            stop.set()
            return [{"name": "Wi-Fi", "address": "172.20.10.3"}]

    class FakeAnnouncement:
        def __init__(self, addresses, port):
            self.address = addresses[0]
            events.append(("publish", self.address, port))

        def close(self):
            events.append(("withdraw", self.address))

    mdns.serve(stop, discover, FakeAnnouncement, 8443, interval=0)
    assert events == [
        ("publish", "192.168.1.10", 8443), ("withdraw", "192.168.1.10"),
        ("publish", "172.20.10.2", 8443), ("withdraw", "172.20.10.2"),
        ("publish", "172.20.10.3", 8443), ("withdraw", "172.20.10.3"),
    ]


def test_real_service_records_and_zeroconf_cleanup(monkeypatch):
    import zeroconf
    created = []

    class FakeZeroconf:
        def __init__(self, **kwargs):
            self.options = kwargs
            created.append(self)

        def register_service(self, info, **kwargs):
            self.info = info
            assert kwargs["allow_name_change"] is False

        def unregister_service(self, info):
            self.withdrawn = info

        def close(self):
            self.closed = True

    monkeypatch.setattr(zeroconf, "Zeroconf", FakeZeroconf)
    monkeypatch.setattr(mdns, "check_name", lambda *_: None)
    announcement = mdns.Announcement(("192.168.43.10",), 9443)
    assert announcement.info.server == "mars.local."
    assert announcement.info.parsed_addresses() == ["192.168.43.10"]
    assert announcement.info.port == 9443
    assert created[0].options["interfaces"] == ["192.168.43.10"]
    announcement.close()
    assert created[0].closed and created[0].withdrawn == announcement.info


def test_probe_rejects_foreign_hostname_and_existing_service(monkeypatch):
    import socket
    from types import SimpleNamespace
    monkeypatch.setattr(mdns.time, "sleep", lambda _: None)

    class Probe:
        existing = None
        address = "192.168.1.99"

        def get_service_info(self, *args, **kwargs):
            return self.existing

        def send(self, query):
            pass

        @property
        def cache(self):
            return self

        def get_all_by_details(self, host, type_, class_):
            return [SimpleNamespace(address=socket.inet_aton(self.address))] if type_ == 1 else []

    probe = Probe()
    with pytest.raises(mdns.NameConflict, match="192.168.1.99"):
        mdns.check_name(probe, ("192.168.1.10",))
    probe.address = "192.168.1.10"
    mdns.check_name(probe, ("192.168.1.10",))
    probe.existing = object()
    with pytest.raises(mdns.NameConflict, match="Another Mars"):
        mdns.check_name(probe, ("192.168.1.10",))
