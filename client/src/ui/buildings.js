export const BUILDINGS = Object.freeze([
  {type:'drill', name:'Бур', icon:'⛏', description:'Копит добычу; заберите ресурсы в рюкзак'},
  {type:'oxygen_generator', name:'Генератор O₂', icon:'O₂', description:'Расходует воду из своего запаса или соседнего склада'},
  {type:'warehouse', name:'Склад', icon:'▤', description:'Хранение ресурсов'},
  {type:'solar_panel', name:'Солнечная панель', icon:'☀', description:'Производит энергию для всех построек мира'},
]);

export function buildingForKey(code) {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match ? BUILDINGS[Number(match[1])-1]?.type ?? null : null;
}
