export const PALETTES=['#e9a878','#8fcbbc','#9babdf','#d6a0c6','#c9c481','#91c7da'];
export function hash(value){let n=2166136261;for(const char of String(value)){n^=char.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0;}
export function defaultProfile(id){return {callsign:'',bio:'',color:hash(id)%PALETTES.length,variant:0,reducedMotion:false};}
export function normalizeProfile(value,id){
 const defaults=defaultProfile(id);
 if(!value || typeof value!=='object')return defaults;
 return {callsign:typeof value.callsign==='string'?value.callsign.trim().slice(0,24):'',
 bio:typeof value.bio==='string'?value.bio.trim().slice(0,100):'',
 color:Number.isInteger(value.color)&&value.color>=0&&value.color<PALETTES.length?value.color:defaults.color,
 variant:Number.isInteger(value.variant)&&value.variant>=0?value.variant%10000:0,reducedMotion:value.reducedMotion===true};
}
export function profileKey(id){return 'mars.profile.v1:'+encodeURIComponent(id);}
export function loadProfile(id,storage){try{return normalizeProfile(JSON.parse(storage.getItem(profileKey(id))),id);}catch{return defaultProfile(id);}}
export function saveProfile(id,profile,storage){const clean=normalizeProfile(profile,id);storage.setItem(profileKey(id),JSON.stringify(clean));return clean;}
export function avatarURL(id,profile){
 const seed=hash(id+':'+profile.variant),color=PALETTES[profile.color]||PALETTES[0];
 let stars='';
 for(let i=0;i<9;i++){const x=12+((seed>>>(i*3))%76),y=9+((seed>>>(i*2))%74);stars+=`<circle cx="${x}" cy="${y}" r="1" fill="${color}" opacity=".45"/>`;}
 let pattern='';
 for(let row=0;row<3;row++)for(let col=0;col<5;col++)if((seed>>>(row*5+col))&1)pattern+=`<rect x="${34+col*7}" y="${36+row*7}" width="4" height="4" rx="1" fill="${color}"/>`;
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100"><rect width="100" height="100" rx="25" fill="#20252b"/>${stars}<path d="M17 100V88c0-22 66-22 66 0v12" fill="${color}"/><rect x="24" y="19" width="52" height="58" rx="25" fill="#e8e4d9"/><rect x="28" y="29" width="44" height="33" rx="14" fill="#17252e"/>${pattern}<path d="M34 35q10-7 20-4" fill="none" stroke="white" opacity=".35" stroke-width="3" stroke-linecap="round"/><rect x="42" y="69" width="16" height="4" rx="2" fill="#647477"/><circle cx="71" cy="87" r="5" fill="#253239"/></svg>`;
 return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
}
