import './style.css';

const status = document.querySelector('#status');
fetch('/api/health')
  .then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    status.textContent = health.status === 'ok' ? 'Сервер и SQLite доступны.' : 'Сервер не готов.';
  })
  .catch(() => { status.textContent = 'Сервер недоступен. Проверьте /api/health и журнал контейнера.'; });
