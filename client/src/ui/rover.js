import "./rover.css";
const fmt = (n) => Number.isFinite(n) ? n.toFixed(4) : "—";
const labels = { iron: "Железо", copper: "Медь", water: "Вода", sulfur: "Сера" };
const errors = { AMBIGUOUS_DIRECTION: "Невозможно выбрать направление", SLOPE_TOO_STEEP: "Слишком крутой склон", PATH_BLOCKED: "Путь перекрыт", AMBIGUOUS_BUILDING: "Рядом несколько подходящих построек", BUILDING_NOT_FOUND: "Подходящая постройка не найдена", CARGO_FULL_OR_LIMIT_TOO_SMALL: "Отсек заполнен или лимит меньше массы единицы", DRILL_EMPTY: "Бур пуст; ожидание добычи", STORAGE_FULL: "Склад заполнен; ожидание места" };
const statuses = { idle: "остановлен", running: "выполняет программу", waiting: "ожидание", error: "ошибка" };
class RoverUI {
  constructor({ events, scene }) {
    Object.assign(this, { events, scene, state: null, selected: null, dirty: false, revision: null });
    this.abort = new AbortController();
    this.pendingCommands = new Map();
    this.button = document.createElement("button");
    this.button.className = "rover-toggle";
    this.button.textContent = "Блокнот / роверы";
    this.button.hidden = true;
    document.querySelector(".header-actions").append(this.button);
    this.panel = document.createElement("dialog");
    this.panel.className = "rover-panel";
    this.panel.setAttribute("aria-labelledby", "rover-panel-title");
    this.panel.innerHTML = `<div class="rover-head"><h2 id="rover-panel-title">Блокнот и роверы</h2><button data-close aria-label="Закрыть">✕</button></div><section><h3>Полевой блокнот</h3><p data-coords></p><button data-survey>Записать точку</button><p data-surveys></p></section><section><h3>Терминал офиса</h3><p data-access></p><div class="rover-row"><label>Имя константы<input data-name placeholder="DRILL" maxlength="24"></label><label>Широта<input data-lat type="number" step="any"></label><label>Долгота<input data-lon type="number" step="any"></label><button data-register>Зарегистрировать</button></div><p data-points></p><div class="rover-row"><label>Машина<select data-select></select></label><button data-purchase>Купить ровер</button><button data-stop>Остановить</button></div><p data-status></p><p>После остановки груз остаётся на борту. Повторный запуск начинает программу с первой строки.</p><label>Программа<textarea data-program spellcheck="false" rows="9" placeholder="move_to(DRILL)&#10;load(20)&#10;move_to(STORAGE)&#10;unload()"></textarea></label><p data-line></p><div class="rover-row"><button data-save>Сохранить</button><button data-run>Запустить</button></div><details><summary>Справка</summary><p><code>move_to(NAME)</code> — к константе; <code>load(20)</code> — взять до 20 кг у бура; <code>unload()</code> — выгрузить на складе; <code>wait(1)</code> — ждать секунду. Для повторения: <code>while true do</code> … <code>end</code>. Ресурс определяется буром.</p></details></section>`;
    this.panel.querySelector('[data-access]').insertAdjacentHTML('afterend', '<p data-feedback role="status" aria-live="polite"></p>');
    this.panel.querySelector('[data-save]').insertAdjacentHTML('afterend', '<button data-reload type="button">Загрузить сохранённую</button>');
    document.body.append(this.panel);
    const on = (q, event, fn) => this.q(q).addEventListener(event, fn, { signal: this.abort.signal });
    this.button.addEventListener("click", () => this.open(), { signal: this.abort.signal });
    on("[data-close]", "click", () => this.panel.close());
    this.panel.addEventListener("keydown", (e) => e.stopPropagation(), { signal: this.abort.signal });
    this.panel.addEventListener("close", () => this.resume(), { signal: this.abort.signal });
    on("[data-survey]", "click", () => this.command("rover.survey", {}));
    on("[data-register]", "click", () => {
      const lat = this.q("[data-lat]").value, lon = this.q("[data-lon]").value;
      if (lat !== "" && lon !== "") this.command("rover.point.register", { name: this.q("[data-name]").value.trim(), latitude: Number(lat), longitude: Number(lon) });
    });
    on("[data-purchase]", "click", () => this.command("rover.purchase", {}));
    on("[data-stop]", "click", () => this.command("rover.stop", { rover_id: this.selected }));
    on("[data-save]", "click", () => this.command("rover.program", { rover_id: this.selected, program: this.q("[data-program]").value, expected_revision: this.revision }));
    on("[data-run]", "click", () => this.command("rover.start", { rover_id: this.selected, expected_revision: this.revision }));
    on("[data-reload]", "click", () => {
      this.dirty = false;
      this.revision = null;
      this.render();
      this.q('[data-feedback]').textContent = 'Загружена сохранённая программа.';
    });
    on("[data-program]", "input", () => {
      this.dirty = true;
      this.render();
    });
    on("[data-select]", "change", (e) => {
      this.selected = e.target.value;
      this.dirty = false;
      this.revision = null;
      this.render();
    });
    this.unsubs = [events.on('rover.command.sent', ({requestId, type}) => this.pendingCommands.set(requestId, type)),
    events.on('command.result', message => this.commandResult(message)),
    events.on("world.state", (s) => {
      this.state = s;
      this.render();
    }), events.on("rover.open", () => this.open()), events.on("connection.status", (s) => {
      if (s !== "connected") {
        this.state = null;
        if (this.panel.open) this.panel.close();
        this.render();
      }
    }), events.on("expedition.lobby", () => {
      if (this.panel.open) this.panel.close();
    })];
  }
  q(s) {
    return this.panel.querySelector(s);
  }
  command(type, payload) {
    this.events.emit("command", { type, payload });
  }
  commandResult(message) {
    const type = this.pendingCommands.get(message.request_id);
    if (!type) return;
    this.pendingCommands.delete(message.request_id);
    if (!this.panel.open) return;
    const result = message.payload || {};
    const success = {'rover.survey':'Точка записана.', 'rover.point.register':'Константа зарегистрирована.', 'rover.purchase':'Ровер куплен.', 'rover.program':'Программа сохранена.', 'rover.start':'Программа запущена.', 'rover.stop':'Ровер остановлен.'};
    const failures = {OFFICE_REQUIRED:'Подойдите к офису в куполе.', SURVEY_LIMIT:'Блокнот заполнен.', SURVEY_REQUIRED:'Сначала запишите координаты в поле.', POINT_EXISTS:'Константа с таким именем уже существует.', POINT_LIMIT:'Реестр точек заполнен.', ROVER_LIMIT:'Достигнут предел количества роверов.', ROVER_RUNNING:'Сначала остановите ровер.', REVISION_CONFLICT:'Программа изменилась у другого игрока. Нажмите «Загрузить сохранённую».', PROGRAM_TOO_LONG:'Программа превышает допустимый размер.', INVALID_PROGRAM:'Ошибка в программе. Проверьте команды и структуру цикла.', UNKNOWN_POINT:'В программе указана неизвестная константа.', INVALID_ARGUMENT:'Проверьте введённые значения.', INSUFFICIENT_RESOURCES:'Не хватает ресурсов.', FORBIDDEN:'Действие недоступно вашей команде.'};
    const feedback = result.ok ? success[type] : (failures[result.code] || `Действие отклонено: ${result.code || 'неизвестная ошибка'}.`);
    this.q('[data-feedback]').textContent = feedback + (Number.isInteger(result.line) ? ` Строка ${result.line}.` : '');
  }
  open() {
    if (!this.state || this.state.stage !== "running" || this.panel.open) return;
    this.scene.controls.suspended = true;
    this.scene.controls.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.events.emit("ui.overlay", true);
    this.panel.showModal();
    this.render();
  }
  resume() {
    if (this.panel.open) return;
    const suspended = !!document.querySelector("dialog[open]");
    this.scene.controls.suspended = suspended;
    this.scene.controls.clear();
    this.events.emit("ui.overlay", suspended);
  }
  render() {
    const s = this.state;
    this.button.hidden = !s || s.stage !== "running";
    if (!s || !this.panel.open) return;
    const c = s.current_coordinates || {};
    this.q("[data-coords]").textContent = `Ваши координаты: ${fmt(c.latitude)}, ${fmt(c.longitude)}`;
    this.q("[data-surveys]").textContent = (s.rover_surveys || []).map((p, i) => `${i + 1}. ${fmt(p.latitude)}, ${fmt(p.longitude)}`).join(" · ") || "Дойдите до нужной точки и запишите координаты.";
    this.q("[data-points]").textContent = (s.rover_points || []).map((p) => `${p.name}: ${fmt(p.latitude)}, ${fmt(p.longitude)}`).join(" · ") || "Общий реестр пуст.";
    const office = !!s.office_access;
    this.q("[data-access]").textContent = office ? "Введите координаты из блокнота вручную." : "Подойдите к офису в куполе для регистрации, покупки, сохранения и запуска.";
    const fleet = s.rover_fleet || [];
    if (!fleet.some((r2) => r2.rover_id === this.selected)) {
      this.selected = fleet[0]?.rover_id || null;
      this.dirty = false;
      this.revision = null;
    }
    const select = this.q("[data-select]");
    const ids = fleet.map((r2) => r2.rover_id).join("|");
    if (select.dataset.ids !== ids) {
      select.replaceChildren(...fleet.map((r2, i) => {
        const o = document.createElement("option");
        o.value = r2.rover_id;
        o.textContent = `Ровер ${i + 1} · ${r2.rover_id.slice(0, 6)}`;
        return o;
      }));
      select.dataset.ids = ids;
      select.value = this.selected || "";
    }
    const r = fleet.find((x) => x.rover_id === this.selected), editor = this.q("[data-program]");
    if (r && !this.dirty && (this.revision !== r.program_revision || editor.dataset.rover !== this.selected)) {
      editor.value = r.program || "";
      this.revision = r.program_revision;
      editor.dataset.rover = this.selected;
    }
    if (r && this.dirty && r.program === editor.value && r.program_revision !== this.revision) {
      this.dirty = false;
      this.revision = r.program_revision;
    }
    if (!r) {
      editor.value = "";
      editor.dataset.rover = "";
      this.revision = null;
      this.dirty = false;
    }
    const cargo = Object.entries(r?.cargo || {}).filter(([, v]) => v).map(([k, v]) => `${labels[k] || k}: ${v}`).join(", ") || "пусто";
    this.q("[data-status]").textContent = r ? `Состояние: ${statuses[r.status] || r.status} · груз: ${cargo} · ${r.cargo_mass ?? "—"} / ${r.capacity ?? "—"} кг · скорость ${r.speed ?? "—"} м/с · уклон ${((r.grade || 0) * 100).toFixed(1)}%${r.error ? " · " + (errors[r.error] || r.error) : ""}` : "Машин пока нет.";
    const line = r?.line && !this.dirty ? r.line : 0;
    const top = 8 + (line - 1) * 19.5;
    editor.style.backgroundImage = line ? `linear-gradient(to bottom, transparent ${top}px, #355a50 ${top}px, #355a50 ${top + 19.5}px, transparent ${top + 19.5}px)` : "none";
    this.q("[data-line]").textContent = r?.line ? `▶ Строка ${r.line}: ${(r.program || "").split("\n")[r.line - 1] || ""}` : "Текущая строка: —";
    for (const k of ["name", "lat", "lon", "register", "purchase", "program", "save", "run"]) this.q(`[data-${k}]`).disabled = !office || ["program", "save", "run"].includes(k) && !r;
    const bytes = new TextEncoder().encode(editor.value).length, max = s.config?.rover?.program_max_bytes || 512;
    this.q("[data-line]").textContent += ` · ${bytes} / ${max} байт`;
    const active = r && ["running", "waiting"].includes(r.status);
    editor.disabled = !office || !r || active;
    this.q("[data-save]").disabled = !office || !r || active || bytes > max;
    this.q("[data-run]").disabled = !office || !r || this.dirty || active;
    this.q("[data-stop]").disabled = !r;
    this.q('[data-reload]').disabled = !r;
    const cost = s.config?.rover?.cost;
    this.q("[data-purchase]").textContent = cost ? `Купить ровер (${Object.entries(cost).map(([k, v]) => `${labels[k] || k}: ${v}`).join(", ")})` : "Купить ровер";
  }
  dispose() {
    if (this.panel.open) {
      this.panel.close();
      this.resume();
    }
    this.unsubs.forEach((fn) => fn());
    this.abort.abort();
    this.button.remove();
    this.panel.remove();
  }
}
export {
  RoverUI
};
