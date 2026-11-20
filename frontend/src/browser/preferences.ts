import {browserStore,STORAGE_KEYS,type StorageLike} from './storage';
export type Theme='auto'|'light'|'dark';
/** Raw strings, not JSON: compatible with theme-boot.js and the legacy UI. */
export class BrowserPreferences {
 private memory=new Map<string,string>();private failed=new Set<string>();
 constructor(private storage:StorageLike=browserStore('localStorage')){}
 private get(key:string){if(this.failed.has(key))return this.memory.get(key);try{return this.storage.getItem(key);}catch{return this.memory.get(key);}}
 private set(key:string,value:string){this.memory.set(key,value);try{this.storage.setItem(key,value);this.failed.delete(key);}catch{this.failed.add(key);}}
 theme():Theme{const theme=this.get(STORAGE_KEYS.theme);return theme==='light'||theme==='dark'?theme:'auto';}
 setTheme(theme:Theme){this.set(STORAGE_KEYS.theme,theme);}
 dismissedRouterUpdates():string[] {
  try {
   const ids:unknown=JSON.parse(this.get(STORAGE_KEYS.dismissedRouterUpdates) || "[]");
   return Array.isArray(ids) ? ids.filter((id):id is string=>typeof id==="string") : [];
  } catch { return []; }
 }
 dismissRouterUpdates(ids:string[]) {
  const merged=[...new Set([...this.dismissedRouterUpdates(), ...ids])].slice(-100);
  this.set(STORAGE_KEYS.dismissedRouterUpdates,JSON.stringify(merged));
  return merged;
 }
 devicesExpanded(){return this.get(STORAGE_KEYS.devicesExpanded)==='true';}
 setDevicesExpanded(expanded:boolean){this.set(STORAGE_KEYS.devicesExpanded,String(expanded));}
}
export const browserPreferences=new BrowserPreferences();
