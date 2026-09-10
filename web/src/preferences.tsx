import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';

export type Language = 'zh' | 'en';
export type Theme = 'dark' | 'light';
export type DataMode = 'live' | 'snapshot';
const dictionary: Record<string, string> = {
  '今天':'Today','本月':'Month','全部':'All time','统计周期':'Period',
  '实时':'Live','快照':'Snapshot','刷新快照':'Refresh snapshot','连接中':'Connecting','重连中':'Reconnecting','离线':'Offline','异常':'Error',
  '离线快照':'Offline snapshot','快照时间':'Captured','Token 用量摘要':'Token usage summary','Token 用量':'Token usage',
  '输入':'Input','输出':'Output','在线设备':'Online devices','工具':'Tools','模型':'Models','设备':'Devices',
  '最近活跃':'Latest activity','近期会话':'Recent sessions','暂无会话':'No sessions','暂无其他会话':'No other sessions','未知工具':'Unknown tool',
  '暂无工具用量':'No tool usage','暂无模型用量':'No model usage','暂无设备':'No devices','平台未知':'Unknown platform',
  '余额与额度':'Balances & quotas','账户余额':'Account balance','订阅额度':'Subscription quotas','暂无额度数据':'No quota data',
  '正常':'OK','未更新':'Stale','需要重新授权':'Sign in again','未配置':'Not configured','不可用':'Unavailable','更新失败':'Update failed',
  '已停用':'Disabled','额度受限':'Quota limited','查询受限':'Rate limited','未知状态':'Unknown status',
  '火山方舟':'Volcengine','当前周期':'Current window','每周':'Weekly','每月':'Monthly','每日':'Daily','账期':'Billing period',
  '余额':'Balance','账户额度':'Account quota','每日限额':'Daily limit','每周限额':'Weekly limit','每月限额':'Monthly limit',
  'API Key 限额':'API key limit','余量未知':'Remaining unknown','额度明细':'Quota details','用量明细':'Usage details',
  '消费估算':'Estimated spending','此 Key 消费':'Key spending','消费':'Spending','今日':'Today','本周':'This week','累计':'All time',
  '暂不可用':'Unavailable','已用未知':'Usage unknown','已用':'Used','总额':'Total','剩余':'Remaining','重置':'Resets','更新':'Updated','到期':'Expires',
  'Spark 额度':'Spark quotas','可用重置':'Available resets','额度':'Quota','5 小时':'5 hours',
  '更新时间未知':'Update time unknown','时间未知':'Time unknown','刚刚':'Just now','在线':'Online',
  '上一页':'Previous','下一页':'Next','列表':' list','分页':' pages',
  '语言':'Language','主题':'Theme','明亮':'Light','深色':'Dark','数据模式':'Data mode','显示设置':'Display settings','退出登录':'Sign out','重新登录':'Sign in again','退出失败，请重试':'Sign-out failed. Try again.','跟随系统':'System',
  '正在连接本地 gateway…':'Connecting…','暂时无法连接 Hub，也没有可用的离线快照。':'Cannot connect to the Hub. No offline snapshot is available.'
};
export function translate(text: string, language: Language): string {
  if (language === 'zh') return text;
  if (dictionary[text]) return dictionary[text];
  const time = text.match(/^(\d+) (分钟|小时|天)前$/);
  if (time) return `${time[1]} ${({ '分钟':'min', '小时':'hr', '天':'d' } as Record<string,string>)[time[2]]} ago`;
  // Compose short UI labels (e.g. Spark · 每周), never run on account/model data.
  let result = text;
  for (const key of Object.keys(dictionary).sort((a,b) => b.length-a.length)) result = result.replaceAll(key, dictionary[key]);
  return result;
}
interface Preferences {
  language: Language; theme: Theme; languageChoice: Language | 'system'; themeChoice: Theme | 'system'; mode: DataMode; refreshSerial: number;
  setLanguage(value: Language | 'system'): void; setTheme(value: Theme | 'system'): void; setMode(value: DataMode): void; refresh(): void;
}
const Context = createContext<Preferences>({ language:'zh',theme:'dark',languageChoice:'system',themeChoice:'system',mode:'live',refreshSerial:0,
  setLanguage:()=>{},setTheme:()=>{},setMode:()=>{},refresh:()=>{} });
function saved(): Partial<Preferences> {
  try { return JSON.parse(window.localStorage.getItem('token-monitor-preferences') || '{}') || {}; } catch { return {}; }
}
export function PreferencesProvider({children}: {children: ComponentChildren}) {
  const [initial] = useState(saved);
  const [languageChoice,setLanguage] = useState<Language | 'system'>(initial.language === 'en' || initial.language === 'zh' ? initial.language : 'system');
  const [themeChoice,setTheme] = useState<Theme | 'system'>(initial.theme === 'light' || initial.theme === 'dark' ? initial.theme : 'system');
  const systemLanguage = () => (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' as const : 'en' as const;
  const [browserLanguage,setBrowserLanguage] = useState<Language>(systemLanguage);
  const [systemDark,setSystemDark] = useState(()=>window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(()=>{
    const media=window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme=()=>setSystemDark(media?.matches ?? false);
    const onLanguage=()=>setBrowserLanguage(systemLanguage());
    media?.addEventListener('change',onTheme);
    window.addEventListener('languagechange',onLanguage);
    return ()=>{media?.removeEventListener('change',onTheme);window.removeEventListener('languagechange',onLanguage);};
  },[]);
  const language=languageChoice==='system' ? browserLanguage : languageChoice;
  const theme=themeChoice==='system' ? (systemDark ? 'dark' : 'light') : themeChoice;
  const [mode,setMode] = useState<DataMode>(initial.mode === 'snapshot' ? 'snapshot' : 'live');
  const [refreshSerial,setRefresh] = useState(0);
  useEffect(()=>{
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f3f6fa' : '#08101d');
    try { window.localStorage.setItem('token-monitor-preferences',JSON.stringify({language:languageChoice,theme:themeChoice,mode})); } catch { /* Storage is optional. */ }
  },[language,theme,mode,languageChoice,themeChoice]);
  return <Context.Provider value={{language,theme,languageChoice,themeChoice,mode,refreshSerial,setLanguage,setTheme,setMode,refresh:()=>setRefresh(x=>x+1)}}>{children}</Context.Provider>;
}
export function usePreferences() {
  const preferences=useContext(Context);
  return {...preferences,t:(text:string)=>translate(text,preferences.language),locale:preferences.language==='zh'?'zh-CN':'en-US'};
}
export function ViewControls() {
  const settings = useRef<HTMLDetailsElement>(null);
  const [logoutError,setLogoutError]=useState(false);
  async function signOut() {
    setLogoutError(false);
    try {
      const response=await fetch('/auth/logout',{method:'POST'});
      if(!response.ok)throw new Error();
      if('caches' in window)for(const name of await caches.keys())if(/^token-monitor-(static|snapshot)-/.test(name))await caches.delete(name);
      if('serviceWorker' in navigator){const registration=await navigator.serviceWorker.getRegistration('/');await registration?.unregister();}
      window.location.assign('/auth/signed-out');
    }catch{setLogoutError(true);}
  }
  useEffect(()=>{
    const closeOutside=(event:PointerEvent)=>{
      if(settings.current && !settings.current.contains(event.target as Node)) settings.current.open=false;
    };
    document.addEventListener('pointerdown',closeOutside);
    return ()=>document.removeEventListener('pointerdown',closeOutside);
  },[]);
  const {languageChoice,themeChoice,mode,setLanguage,setTheme,setMode,refresh,t}=usePreferences();
  return <div class="view-controls">
    <div class="mode-switch" role="group" aria-label={t('数据模式')}>
      {(['live','snapshot'] as const).map(value=><button type="button" aria-pressed={mode===value} onClick={()=>setMode(value)}>{t(value==='live'?'实时':'快照')}</button>)}
    </div>
    {mode==='snapshot' && <button class="icon-button" type="button" aria-label={t('刷新快照')} title={t('刷新快照')} onClick={refresh}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg></button>}
    <details ref={settings} class="display-settings" onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}>
      <summary class="icon-button" aria-label={t('显示设置')} title={t('显示设置')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg></summary>
      <div class="settings-popover">
        <label><span>{t('语言')}</span><select aria-label={t('语言')} value={languageChoice} onChange={e=>setLanguage(e.currentTarget.value as Language | 'system')}><option value="system">{t('跟随系统')}</option><option value="zh">中文</option><option value="en">English</option></select></label>
        <label><span>{t('主题')}</span><select aria-label={t('主题')} value={themeChoice} onChange={e=>setTheme(e.currentTarget.value as Theme | 'system')}><option value="system">{t('跟随系统')}</option><option value="dark">{t('深色')}</option><option value="light">{t('明亮')}</option></select></label>
        <button type="button" class="sign-out" onClick={signOut}>{t('退出登录')}</button>
        {logoutError && <p role="alert">{t('退出失败，请重试')}</p>}
      </div>
    </details>
  </div>;
}
