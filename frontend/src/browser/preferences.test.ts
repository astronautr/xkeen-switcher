import {it,expect} from '@rstest/core';
import {BrowserPreferences} from './preferences';
it('B04 theme and devices expansion preserve literal legacy formats with memory fallback',()=>{
 const map=new Map<string,string>();let denied=false;const store={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{if(denied)throw Error('denied');map.set(k,v);},removeItem:(k:string)=>map.delete(k)};
 const preferences=new BrowserPreferences(store);expect(preferences.theme()).toBe('auto');expect(preferences.devicesExpanded()).toBe(false);preferences.setTheme('dark');preferences.setDevicesExpanded(true);expect(map.get('xk_theme')).toBe('dark');expect(map.get('xk_devices_expanded')).toBe('true');denied=true;preferences.setTheme('light');expect(preferences.theme()).toBe('light');
});
