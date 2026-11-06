import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,FileText} from 'lucide-react';
import {CONFIG} from '../../config';
import {Shell} from '../Shell.jsx';
import {ago,duration,paidText,shortAddress} from '../exitsFormat.js';
import {OUTCOMES,outcomeDetail,outcomeLabel,postOnXUrl,recordQuery,reviewLine,ruleLabel,tweetText,verdictLabel} from '../alarmsFormat.js';
import './alarms.css';

const PAGE=20;
const KNOWN={[CONFIG.planToken.toLowerCase()]:{symbol:'USDG',decimals:6}};

async function load(filters,before,signal) {
  if(!CONFIG.apiUrl)throw new Error('no api');
  const res=await fetch(`${CONFIG.apiUrl}/alarms/record?${recordQuery({...filters,before,limit:PAGE})}`,{signal});
  if(!res.ok)throw new Error(String(res.status));
  const body=await res.json();
  if(!Array.isArray(body.alarms)||!body.summary)throw new Error('bad answer');
  return body;
}

function Stat({label,value,note}) {
  return <div className="al-stat"><dt>{label}</dt><dd>{value}</dd>{note&&<small>{note}</small>}</div>;
}

function Summary({s}) {
  return <dl className="al-stats" aria-label="Summary">
    <Stat label="Alarms fired" value={s.fired.all.toLocaleString('en-US')} note={`${s.fired.last7d} in 7 days · ${s.fired.last30d} in 30 days`}/>
    <Stat label="Exits that followed" value={s.exits.toLocaleString('en-US')} note={s.fired.all?`After ${s.alarmsWithExit} of ${s.fired.all} alarms`:'Nothing to follow yet'}/>
    <Stat label="Typical time to exit" value={duration(s.medianSecondsToExit)||'Not yet'} note={s.medianSecondsToExit===null?'Needs an alarm with an exit':'Median, alarm to first exit'}/>
    <Stat label="Misses" value={s.noExit.toLocaleString('en-US')} note="Armed positions, no exit in 24 hours"/>
    <Stat label="False alarms" value={s.falseAlarms.falseAlarm.toLocaleString('en-US')} note={`${s.falseAlarms.confirmed} confirmed · ${s.falseAlarms.unreviewed} not yet reviewed`}/>
  </dl>;
}

function Row({a,now}) {
  const out=outcomeLabel(a);
  const verdict=verdictLabel(a.review.verdict);
  const paid=a.exits.returned.map((p)=>{const t=paidText(p,KNOWN[p.token.toLowerCase()]);return `${t.amount} ${t.unit} came back`;}).join(', ');
  return <li className="al-row">
    <div className="al-when"><time dateTime={new Date(a.firedAt*1000).toISOString()} title={new Date(a.firedAt*1000).toUTCString()}>{ago(now,a.firedAt)}</time></div>
    <div className="al-who">
      <h3>{a.vault.name||'Unnamed vault'}</h3>
      <p>{a.alarm.name} · <span className={`al-rule al-rule-${a.alarm.rule}`}>{ruleLabel(a.alarm.rule)}</span></p>
      {a.alarm.rule==='quorum'&&<p className="al-sub">{a.alarm.signers.length?`Signed by ${a.alarm.signers.join(', ')}`:'No signatures stored'}{a.alarm.evidence&&<> · evidence <code>{shortAddress(a.alarm.evidence)}</code></>}</p>}
    </div>
    <div className="al-out">
      <span className={`al-pill al-pill-${out.tone}`}>{out.text}</span>
      <p>{outcomeDetail(a,paid)}</p>
    </div>
    <div className="al-rev">
      <span className={`al-pill al-pill-${verdict.tone}`}>{verdict.text}</span>
      {a.review.note&&<p>{a.review.note}</p>}
    </div>
    <div className="al-links">
      {a.exits.links.map((l)=><a key={l.tx} href={`receipt.html#${l.tx}`}><FileText size={14} aria-hidden="true"/>Exit receipt</a>)}
      {a.alarm.tx&&<a href={`${CONFIG.explorer}/tx/${a.alarm.tx}`} target="_blank" rel="noopener noreferrer">Alarm transaction<ArrowUpRight size={14} aria-hidden="true"/></a>}
    </div>
  </li>;
}

function Explainer() {
  return <section className="al-how" aria-labelledby="al-how-h">
    <h2 id="al-how-h">How to read this record</h2>
    <div className="al-how-grid">
      <div><h3>Hard rule or watcher quorum</h3><p>A <strong>hard rule</strong> alarm fires from the chain alone, such as a vault's share price falling 0.5% below its high. A <strong>watcher quorum</strong> alarm fires only when enough approved watchers sign the same evidence, and each row names the ones that did. Soft signals like a big withdrawal or a curator change need that confirmation.</p></div>
      <div><h3>What happened next</h3><p>An exit counts when it ran within 24 hours of the alarm, the length of an alarm's life. <strong>No armed positions</strong> means nobody had that alarm armed, so no exit was due. <strong>No exit</strong> means someone did, and no exit followed. That is a miss, and it is counted as one.</p></div>
      <div><h3>How false alarms are marked</h3><p>Canopy's operator reviews fired alarms by hand and marks each as confirmed or a false alarm, with a note. An alarm nobody has reviewed shows as <strong>not yet reviewed</strong>. It is never counted as correct. The false-alarm count is only as good as that review, so the notes are public too.</p></div>
    </div>
    <p className="al-small">Alarms from launch tests, run with an alarm made to always fire, are listed like any other. No wallet addresses are listed. Watchers are public roles, so their addresses are shortened.</p>
  </section>;
}

export default function Alarms() {
  const [state,setState]=useState({status:'loading',summary:null,vaults:[],alarms:[],total:0,next:null});
  const [filters,setFilters]=useState({vault:'',outcome:''});
  const [more,setMore]=useState(false);
  const [moreFailed,setMoreFailed]=useState(false);
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
  const vaultsSeen=useRef([]);

  const first=useCallback((f,signal)=>{
    setState((s)=>({...s,status:'loading'}));
    load(f,null,signal).then((b)=>{
      setNow(Math.floor(Date.now()/1000));
      vaultsSeen.current=b.vaults||vaultsSeen.current;
      setState({status:'ready',summary:b.summary,vaults:vaultsSeen.current,alarms:b.alarms,total:b.total,next:b.next});
    },(err)=>{if(err.name!=='AbortError')setState({status:'error',summary:null,vaults:vaultsSeen.current,alarms:[],total:0,next:null});});
  },[]);
  useEffect(()=>{const c=new AbortController();first(filters,c.signal);return()=>c.abort();},[first,filters]);

  const older=()=>{
    setMore(true);setMoreFailed(false);
    load(filters,state.next).then((b)=>setState((s)=>({...s,alarms:[...s.alarms,...b.alarms],next:b.next})),()=>setMoreFailed(true)).finally(()=>setMore(false));
  };
  const set=(k)=>(e)=>setFilters((f)=>({...f,[k]:e.target.value}));
  const filtered=!!(filters.vault||filters.outcome);
  const postUrl=state.summary?postOnXUrl(tweetText(state.summary),window.location.href.split('#')[0]):null;

  return <Shell page="alarms">
    <header className="wp-head rm-head al-head">
      <div className="doc-eyebrow">PUBLIC ALARM RECORD</div>
      <h1>Every alarm, hits and misses.</h1>
      <p className="wp-abstract">Every alarm that has fired on a listed vault, what happened next, and an honest count of the false ones. Misses stay on the list, and an alarm nobody has reviewed is shown as not yet reviewed.</p>
      {postUrl&&<a className="al-post" href={postUrl} target="_blank" rel="noopener noreferrer">Post on X<ArrowUpRight size={15} aria-hidden="true"/></a>}
    </header>
    {state.summary&&<Summary s={state.summary}/>}
    {state.summary&&<p className="al-reviewline">{reviewLine(state.summary.falseAlarms)}</p>}
    <main className="al-main" aria-busy={state.status==='loading'}>
      <form className="al-filters" onSubmit={(e)=>e.preventDefault()} aria-label="Filters">
        <label>Vault<select value={filters.vault} onChange={set('vault')}><option value="">All vaults</option>{state.vaults.map((v)=><option key={v.address} value={v.address}>{v.name}</option>)}</select></label>
        <label>Outcome<select value={filters.outcome} onChange={set('outcome')}>{OUTCOMES.map((o)=><option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
        {state.status==='ready'&&<p className="al-count" role="status">{state.total.toLocaleString('en-US')} {state.total===1?'alarm':'alarms'}{filtered?' match':''}</p>}
      </form>
      {state.status==='loading'&&<div role="status" aria-label="Loading alarms"><ul className="al-list" aria-hidden="true">{[0,1,2].map((i)=><li className="al-skel" key={i}/>)}</ul></div>}
      {state.status==='error'&&<div className="al-state" role="alert"><h2>The alarm record is not reachable right now.</h2><p>The service that lists alarms did not answer. Your alarms and exits are not affected, and everything here is also on the chain. Try again in a moment.</p><button type="button" onClick={()=>first(filters)}>Try again</button></div>}
      {state.status==='ready'&&state.alarms.length===0&&(filtered
        ?<div className="al-state"><h2>No alarms match those filters.</h2><p>Clear a filter to see the rest of the record.</p><button type="button" onClick={()=>setFilters({vault:'',outcome:''})}>Clear filters</button></div>
        :<div className="al-state"><h2>No alarm has fired yet.</h2><p>That is the record so far, not a promise about what comes next. When an alarm fires on a listed vault it appears here with what happened next, whether it was a hit, a miss or a false alarm.</p></div>)}
      {state.status==='ready'&&state.alarms.length>0&&<>
        <p className="al-note">Newest first. Times come from the chain.</p>
        <ol className="al-list">{state.alarms.map((a)=><Row key={`${a.key}:${a.firedAt}`} a={a} now={now}/>)}</ol>
        {state.next&&<button type="button" className="al-more" onClick={older} disabled={more}>{more?'Loading…':'Show older alarms'}</button>}
        {moreFailed&&<p className="al-note" role="alert" style={{textAlign:'center',marginTop:12}}>Could not load older alarms. Try again.</p>}
      </>}
    </main>
    <Explainer/>
  </Shell>;
}
