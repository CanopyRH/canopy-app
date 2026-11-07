import React,{useCallback,useEffect,useState} from 'react';
import {ArrowUpRight,CheckCircle2,CircleHelp,TriangleAlert,OctagonAlert} from 'lucide-react';
import {CONFIG} from '../../config';
import copy from '../../copy/status.json';
import {Shell} from '../Shell.jsx';
import {ago,blocks,dayLabel,duration,eventTitle,levels,shortAddress,validStatus,verdict} from '../statusFormat.js';
import './status.css';

const POLL_MS=30000;
const ICON={ok:CheckCircle2,warn:TriangleAlert,bad:OctagonAlert,unknown:CircleHelp};
const WORD={ok:'Normal',warn:'Watch',bad:'Attention',unknown:'Unknown'};

async function load(signal) {
  if(!CONFIG.apiUrl)throw new Error('no api');
  const res=await fetch(`${CONFIG.apiUrl}/status`,{signal});
  if(!res.ok)throw new Error(String(res.status));
  const body=await res.json();
  if(!validStatus(body))throw new Error('bad answer');
  return body;
}

const when=(now,at,never)=>at===null||at===undefined?never:<time dateTime={new Date(at*1000).toISOString()} title={new Date(at*1000).toUTCString()}>{ago(now,at)}</time>;

function Level({level}) {
  const Icon=ICON[level];
  return <span className={`st-level st-${level}`}><Icon size={14} aria-hidden="true"/>{WORD[level]}</span>;
}

function Row({k,children,level}) {
  return <div className="st-row"><dt>{k}</dt><dd>{children}{level&&<Level level={level}/>}</dd></div>;
}

function Card({title,about,children}) {
  return <section className="st-card" aria-label={title}><h2>{title}</h2><p className="st-about">{about}</p>{children}</section>;
}

function Link({href,children}) {
  return href?<a className="st-link" href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true"/></a>:null;
}

export function Board({s}) {
  const now=s.generatedAt;
  const lv=levels(s,now);
  const max=Math.max(1,...s.alarmFirings.byDay.map((d)=>d.count));
  return <>
    <div className="st-grid">
      <Card title={copy.keeper.title} about={copy.keeper.about}>
        <dl>
          <Row k={copy.keeper.lastActed}>{when(now,s.keeper.lastActedAt,copy.keeper.never)}</Row>
          <Row k={copy.keeper.gas} level={lv.gas}>{copy.keeper.gasLabels[s.keeper.gas]||copy.keeper.gasLabels.unknown}</Row>
          <Row k={copy.keeper.queue} level={lv.queue}>{s.keeper.queueDepth?s.keeper.queueDepth:copy.keeper.queueNone}</Row>
          {s.keeper.queueDepth>0&&<Row k={copy.keeper.oldest}>{duration(s.keeper.oldestQueuedSec)}</Row>}
        </dl>
      </Card>
      <Card title={copy.indexer.title} about={copy.indexer.about}>
        <dl>
          <Row k={copy.indexer.lag} level={lv.indexer}>{blocks(s.indexer.lagBlocks)||copy.indexer.unknown}</Row>
        </dl>
        {s.indexer.state==='behind'&&<p className="st-warn" role="status">{copy.indexer.behind}</p>}
      </Card>
      <Card title={copy.checks.title} about={copy.checks.about}>
        <dl>
          <Row k={copy.checks.last} level={lv.checks}>{when(now,s.alarmChecks.lastCheckedAt,copy.checks.never)}</Row>
        </dl>
        {lv.checks==='bad'&&<p className="st-warn" role="status">{copy.checks.stale}</p>}
      </Card>
      <Card title={copy.watchers.title} about={copy.watchers.about}>
        {s.watchers.policy&&<p className="st-empty">Feed confirmations require operator-reviewed report attribution. {s.watchers.policy.reportAttributionConfigured?'Attribution file configured.':'Attribution file is not configured; feed signing is disabled.'} {s.watchers.policy.diversityRequired?(s.watchers.policy.profilesConfigured?'Reviewed diversity profiles configured.':'Diversity profiles are missing; hosted quorum submission is disabled.'):'Diversity enforcement is disabled on this host.'} Configuration does not prove independent operators.</p>}
        {s.watchers.list.length===0?<p className="st-empty">{copy.watchers.none}</p>:<dl>
          {s.watchers.list.map((w)=><Row key={w.address} k={<code title={w.address}>{shortAddress(w.address)}</code>}>{when(now,w.lastAttestedAt,copy.watchers.never)}</Row>)}
        </dl>}
      </Card>
    </div>

    <section className="st-wide" aria-label={copy.firings.title}>
      <h2>{copy.firings.title}</h2>
      <p className="st-about">{copy.firings.about}</p>
      {s.alarmFirings.total===0?<p className="st-empty">{copy.firings.empty}</p>:<>
        <p className="st-total"><strong>{s.alarmFirings.total.toLocaleString('en-US')}</strong> {copy.firings.total.toLowerCase()}</p>
        <ol className="st-days">{s.alarmFirings.byDay.map((d)=><li key={d.daysAgo}>
          <span className="st-dl">{dayLabel(d.daysAgo)}</span>
          <span className="st-bar" aria-hidden="true"><i style={{width:`${(d.count/max)*100}%`}}/></span>
          <span className="st-n">{d.count}</span>
        </li>)}</ol>
        <ul className="st-list">{s.alarmFirings.recent.map((a)=><li key={`${a.key}${a.firedAt}`}>
          <span>{when(now,a.firedAt)}</span><code title={a.key}>{shortAddress(a.key)}</code><Link href={a.txUrl}>{copy.firings.link}</Link>
        </li>)}</ul>
      </>}
    </section>

    <section className="st-wide" aria-label={copy.history.title}>
      <h2>{copy.history.title}</h2>
      <p className="st-about">{copy.history.about}</p>
      {s.history.length===0?<p className="st-empty">{copy.history.empty}</p>:<ul className="st-list">{s.history.map((h)=><li key={`${h.tx}${h.event}${h.block}`}>
        <span>{when(now,h.at)}</span>
        <span className="st-ev">{eventTitle(h.event)}<small>{h.contract}{h.block===null?'':` · block ${h.block.toLocaleString('en-US')}`}</small></span>
        <Link href={h.txUrl}>{copy.history.link}</Link>
      </li>)}</ul>}
    </section>
  </>;
}

export default function Status() {
  const [state,setState]=useState({status:'loading',data:null,fetchedAt:0});
  const run=useCallback((signal)=>load(signal).then(
    (data)=>setState({status:'ready',data,fetchedAt:Date.now()}),
    (err)=>{if(err.name!=='AbortError')setState((s)=>s.data?{...s,status:'stale'}:{status:'error',data:null,fetchedAt:0});},
  ),[]);
  useEffect(()=>{
    const c=new AbortController();
    run(c.signal);
    const t=setInterval(()=>run(c.signal),POLL_MS);
    return()=>{c.abort();clearInterval(t);};
  },[run]);

  const data=state.data;
  const v=data?verdict(data,data.generatedAt):'unknown';
  const Icon=ICON[v];
  return <Shell page="status">
    <header className="wp-head rm-head st-head">
      <div className="doc-eyebrow">{copy.eyebrow}</div>
      <h1>{copy.title}</h1>
      <p className="wp-abstract">{copy.intro}</p>
    </header>
    <main className="st-main" aria-busy={state.status==='loading'}>
      {state.status==='loading'&&<div role="status" aria-label={copy.loadingLabel}><div className="st-skel" aria-hidden="true"/><div className="st-grid" aria-hidden="true">{[0,1,2,3].map((i)=><div className="st-skel st-skel-card" key={i}/>)}</div></div>}
      {state.status==='error'&&<div className="st-state" role="alert"><h2>{copy.error.title}</h2><p>{copy.error.body}</p><button type="button" onClick={()=>{setState({status:'loading',data:null,fetchedAt:0});run();}}>{copy.error.retry}</button></div>}
      {data&&<>
        <div className={`st-verdict st-${v}`} role="status"><Icon size={26} aria-hidden="true"/><div><strong>{copy.verdict[v]}</strong><small>{copy.updated} <time dateTime={new Date(data.generatedAt*1000).toISOString()}>{new Date(data.generatedAt*1000).toUTCString()}</time>{state.status==='stale'&&' · could not refresh just now'}</small></div></div>
        <Board s={data}/>
      </>}
    </main>
    <div className="st-end"><p>{copy.footer}</p></div>
  </Shell>;
}
