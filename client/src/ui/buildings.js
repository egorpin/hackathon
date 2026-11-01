export const BUILDINGS = Object.freeze([
  {type:'drill', name:'Бур', icon:'⛏', description:'Три робота строят за 20 секунд; после завершения копит добычу'},
  {type:'oxygen_generator', name:'Генератор O₂', icon:'O₂', description:'Три робота строят за 20 секунд; расходует воду после завершения'},
  {type:'warehouse', name:'Склад', icon:'▤', description:'Три робота строят за 20 секунд; хранение ресурсов после завершения'},
  {type:'solar_panel', name:'Солнечная панель', icon:'☀', description:'Схема постройки; три робота возводят за 20 секунд'},
  {type:'wind_turbine', name:'Ветрогенератор', icon:'↟', description:'Схема постройки; три робота возводят за 20 секунд'},
]);

export function buildingForKey(code) {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match ? BUILDINGS[Number(match[1])-1]?.type ?? null : null;
}
