import React,{useCallback,useEffect,useState} from 'react';
import {ArrowUpRight,FileText} from 'lucide-react';
import {CONFIG} from '../../config';
import {Shell} from '../Shell.jsx';
import {ago,alarmTitle,duration,paidText,shortAddress} from '../exitsFormat.js';
import './exits.css';

// The app's own vault list names a vault when the server has no risk card for it yet.
const listedName=(a)=>CONFIG.vaults.find((v)=>v.address.toLowerCase()===a.toLowerCase())?.name;

const PAGE=20;
// Tokens the page can name even when the API does not.
const KNOWN={[CONFIG.planToken.toLowerCase()]:{symbol:'USDG',decimals:6}};

async function load(before,signal) {
  if(!CONFIG.apiUrl)throw new Error('no api');
  const q=new URLSearchParams({limit:String(PAGE)});
  if(before)q.set('before',before);
  const res=await fetch(`${CONFIG.apiUrl}/exits?${q}`,{signal});
  if(!res.ok)throw new Error(String(res.status));
  const body=await res.json();
  if(!Array.isArray(body.exits)||!body.summary)throw new Error('bad answer');
  return body;
}

function Stat({label,value,note}) {
  return <div className="ex-stat"><dt>{label}</dt><dd>{value}</dd>{note&&<small>{note}</small>}</div>;
}

function Summary({s}) {
  return <dl className="ex-stats" aria-label="Summary">
    <Stat label="Exits so far" value={s.total.toLocaleString('en-US')}/>
    <Stat label="Typical alarm to exit" value={duration(s.medianSeconds)||'Not yet'} note={s.timed?`Median of ${s.timed} timed exit${s.timed===1?'':'s'}`:'Needs an exit run by an alarm'}/>
    <Stat label="Longest alarm to exit" value={duration(s.longestSeconds)||'Not yet'}/>
  </dl>;
}

function Row({e,now}) {
  const when=ago(now,e.ranAt);
  const speed=duration(e.seconds);
  return <li className="ex-row">
    <div className="ex-when">{e.ranAt===null?'Time not available':<time dateTime={new Date(e.ranAt*1000).toISOString()} title={new Date(e.ranAt*1000).toUTCString()}>{when}</time>}</div>
    <div className="ex-who">
      <h3>{e.vault?(e.vault.name||listedName(e.vault.address)||'Unnamed vault'):'Unknown vault'}</h3>
      <p>{e.vault&&<>{shortAddress(e.vault.address)} · </>}{e.alarm?alarmTitle(e.alarm.name):'Exit without an alarm'}</p>
    </div>
    <div><span className="ex-k">Alarm to exit</span><span className="ex-v">{speed||'Not available'}</span></div>
    <div><span className="ex-k">Came back</span><div className="ex-v">{e.paid.length?e.paid.map((p,i)=>{const t=paidText(p,KNOWN[p.token.toLowerCase()]);return <div key={i}>{t.amount} <small>{t.unit}</small></div>;}):<small>Nothing recorded</small>}</div></div>
    <div className="ex-links">
      <a href={`receipt.html#${e.tx}`}><FileText size={14} aria-hidden="true"/>Receipt</a>
      <a href={`${CONFIG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener noreferrer">Transaction<ArrowUpRight size={14} aria-hidden="true"/></a>
    </div>
  </li>;
}

export default function Exits() {
  const [state,setState]=useState({status:'loading',summary:null,exits:[],next:null});
  const [more,setMore]=useState(false);
  const [moreFailed,setMoreFailed]=useState(false);
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));

  const first=useCallback((signal)=>{
    setState((s)=>({...s,status:'loading'}));
    load(null,signal).then((b)=>{setNow(Math.floor(Date.now()/1000));setState({status:'ready',summary:b.summary,exits:b.exits,next:b.next});},(err)=>{if(err.name!=='AbortError')setState({status:'error',summary:null,exits:[],next:null});});
  },[]);
  useEffect(()=>{const c=new AbortController();first(c.signal);return()=>c.abort();},[first]);

  const older=()=>{
    setMore(true);setMoreFailed(false);
    load(state.next).then((b)=>setState((s)=>({...s,summary:b.summary,exits:[...s.exits,...b.exits],next:b.next})),()=>setMoreFailed(true)).finally(()=>setMore(false));
  };

  return <Shell page="exits">
    <header className="wp-head rm-head ex-head">
      <div className="doc-eyebrow">LIVE EXIT LOG</div>
      <h1>Every exit, in public.</h1>
      <p className="wp-abstract">Each time an alarm fires and Canopy exits a position, it lands here: which vault, which alarm, how long it took, what came back, and the transaction. No wallet addresses are listed.</p>
    </header>
    {state.summary&&<Summary s={state.summary}/>}
    <main className="ex-main" aria-busy={state.status==='loading'}>
      {state.status==='loading'&&<div role="status" aria-label="Loading exits"><ul className="ex-list" aria-hidden="true">{[0,1,2].map((i)=><li className="ex-skel" key={i}/>)}</ul></div>}
      {state.status==='error'&&<div className="ex-state" role="alert"><h2>The exit log is not reachable right now.</h2><p>The service that lists exits did not answer. Your alarms and exits are not affected, and the transactions stay on the chain. Try again in a moment.</p><button type="button" onClick={()=>first()}>Try again</button></div>}
      {state.status==='ready'&&state.exits.length===0&&<div className="ex-state"><h2>No exits yet.</h2><p>Nothing has needed to exit. When an alarm fires for an armed position, the exit shows up here.</p></div>}
      {state.status==='ready'&&state.exits.length>0&&<>
        <p className="ex-note">Newest first. The first exits on the list were launch tests, run with an alarm made to always fire. They are shown like any other.</p>
        <ol className="ex-list">{state.exits.map((e)=><Row key={e.id} e={e} now={now}/>)}</ol>
        {state.next&&<button type="button" className="ex-more" onClick={older} disabled={more}>{more?'Loading…':'Show older exits'}</button>}
        {moreFailed&&<p className="ex-note" role="alert" style={{textAlign:'center',marginTop:12}}>Could not load older exits. Try again.</p>}
      </>}
    </main>
    <div className="ex-end"><p>Times come from the chain. "Alarm to exit" runs from the moment the alarm fired to the moment the exit was mined. To check one yourself, open its transaction on the explorer.</p></div>
  </Shell>;
}
