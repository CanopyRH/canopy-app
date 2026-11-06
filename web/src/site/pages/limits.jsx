import React,{useCallback,useEffect,useState} from 'react';
import {ArrowUpRight,CalendarClock,Ban,CircleHelp,RefreshCw,Share2,ShieldOff} from 'lucide-react';
import {Shell} from '../Shell.jsx';
import {CHAINS,offered,pick,savedChain,saveChain} from '../../config';
import {loadLimits,countdown,headline,utcDate,utcDay,tweetText,tweetUrl,delayText,shortAddress,watcherState,chainNow,addressUrl,sourceLinks} from '../../limits';
import {CANNOT,ADMIN_REFS,WATCHER_REFS,FACT_NAMES,LIMITS_COPY as T} from '../../copy/limits';
import './limits.css';

// Only networks with live contracts, as in the app header. Base joins this list on its deploy.
const OFFERED=offered(CHAINS);

const now=()=>Math.floor(Date.now()/1000);

// Reads one network's limits, and again on request. A new network or a retry starts from a clean "loading".
function useLimits(chain){
  const [state,setState]=useState({status:'loading'});
  const [tries,setTries]=useState(0);
  useEffect(()=>{
    let live=true;
    setState({status:'loading'});
    loadLimits(chain).then((limits)=>{if(live)setState({status:'ready',limits});}).catch(()=>{if(live)setState({status:'failed'});});
    return()=>{live=false;};
  },[chain,tries]);
  return [state,useCallback(()=>setTries((n)=>n+1),[])];
}

// Ticks every 15 seconds. The countdown shows whole minutes, so a faster clock would only repaint.
function useClock(){
  const [t,setT]=useState(now());
  useEffect(()=>{const id=setInterval(()=>setT(now()),15000);return()=>clearInterval(id);},[]);
  return t;
}

function Unread({what,chain}){
  return <p className="lm-unread" role="status"><CircleHelp size={16} aria-hidden="true"/><span>Could not read {what} from {chain.chainName}. It is left blank, not guessed.</span></p>;
}

function Addr({chain,a}){
  return <a className="lm-addr" href={addressUrl(chain,a)} target="_blank" rel="noopener noreferrer" title={a}>{shortAddress(a)}<ArrowUpRight size={12} aria-hidden="true"/></a>;
}

// The contract a source line belongs to, from this network's config.
const addressOf=(chain,ref)=>ref.contract==='router'?chain.router:ref.contract==='alarmBook'?chain.alarmBook:null;

function SourceLine({chain,r}){
  const address=addressOf(chain,r);
  if(!address)return null;
  const links=sourceLinks(chain,address);
  return <p className="lm-src">
    <code>{r.file} line {r.line}</code>
    <span><a href={links.explorer} target="_blank" rel="noopener noreferrer">{links.explorerName}<ArrowUpRight size={12} aria-hidden="true"/></a><a href={links.sourcify} target="_blank" rel="noopener noreferrer">Sourcify<ArrowUpRight size={12} aria-hidden="true"/></a></span>
    <small>{r.quote}</small>
  </p>;
}

function Countdown({limits,t}){
  const {chain,expiry}=limits;
  if(!expiry.ok)return <section className="lm-hero" aria-labelledby="lm-count"><p className="lm-kicker"><CalendarClock size={14} aria-hidden="true"/>Admin powers</p><h2 id="lm-count" className="lm-big">Date unread</h2><Unread what={FACT_NAMES.expiry} chain={chain}/></section>;
  const c=countdown(expiry.value,chainNow(limits,t));
  const text=tweetText(c);
  return <section className="lm-hero" aria-labelledby="lm-count">
    <p className="lm-kicker"><CalendarClock size={14} aria-hidden="true"/>Admin powers</p>
    <h2 id="lm-count" className="lm-big">{headline(c)}</h2>
    <p className="lm-date">{c.ended?'They ended on':'Exact date:'} <strong>{utcDate(expiry.value)}</strong></p>
    {!c.ended&&<dl className="lm-units" aria-hidden="true">
      <div><dt>days</dt><dd>{c.days}</dd></div><div><dt>hours</dt><dd>{c.hours}</dd></div><div><dt>minutes</dt><dd>{c.minutes}</dd></div>
    </dl>}
    <h3>{T.endsHeading}</h3>
    <p className="lm-body">{c.ended?T.endedBody:T.endsBody}</p>
    <h3>{T.staysHeading}</h3>
    <p className="lm-body">{T.staysBody}</p>
    <SourceLine chain={chain} r={ADMIN_REFS.expiry}/>
    <div className="lm-actions"><a className="lm-post" href={tweetUrl(text)} target="_blank" rel="noopener noreferrer"><Share2 size={16} aria-hidden="true"/>{T.tweet.button}</a></div>
  </section>;
}

function Cannot({chain}){
  return <section className="lm-sec" aria-labelledby="lm-cannot">
    <h2 id="lm-cannot">{T.cannotHeading}</h2>
    <p className="lm-lead">{T.cannotLead}</p>
    <ul className="lm-cards">{CANNOT.map((s)=><li key={s.id} className="lm-card">
      <h3><Ban size={18} aria-hidden="true"/>{s.title}</h3>
      <p>{s.why}</p>
      {s.refs.map((r)=><SourceLine key={r.line} chain={chain} r={r}/>)}
    </li>)}</ul>
  </section>;
}

function Row({label,children,refx,chain}){
  return <div className="lm-row"><dt>{label}</dt><dd>{children}{refx&&<SourceLine chain={chain} r={refx}/>}</dd></div>;
}

function Admin({limits,t}){
  const {chain}=limits;
  const c=limits.expiry.ok?countdown(limits.expiry.value,chainNow(limits,t)):null;
  return <section className="lm-sec" aria-labelledby="lm-admin">
    <h2 id="lm-admin">{T.adminHeading(Boolean(c&&c.ended))}</h2>
    <p className="lm-lead">{T.adminLead}</p>
    <dl className="lm-rows">
      <Row label="Adapters allowed" chain={chain} refx={ADMIN_REFS.adapters}>
        {limits.adapters.ok?(limits.adapters.value.length===0?<span>None</span>:<ul className="lm-plain">{limits.adapters.value.map((a)=><li key={a.adapter}><Addr chain={chain} a={a.adapter}/> <span className={a.allowed?'lm-pill lm-on':'lm-pill'}>{a.allowed?'Allowed':'Turned off'}</span></li>)}</ul>)
          :<Unread what={FACT_NAMES.adapters} chain={chain}/>}
      </Row>
      <Row label="Guardian" chain={chain} refx={ADMIN_REFS.guardian}>
        {limits.guardian.ok?<><Addr chain={chain} a={limits.guardian.value}/><small>Can pause new arming. Can't pause exits, disarming or claims.</small></>:<Unread what={FACT_NAMES.guardian} chain={chain}/>}
      </Row>
      <Row label="New arming" chain={chain} refx={ADMIN_REFS.pause}>
        {limits.armingPaused.ok?<span className={limits.armingPaused.value?'lm-pill lm-warn':'lm-pill lm-on'}>{limits.armingPaused.value?'Paused':'Not paused'}</span>:<Unread what={FACT_NAMES.paused} chain={chain}/>}
        {limits.armingPaused.ok&&limits.armingPaused.value&&c&&c.ended&&<small>The pause no longer has any effect, because the admin's date has passed.</small>}
      </Row>
      <Row label="Timelock delay">
        {limits.delay.ok?<><strong>{delayText(limits.delay.value)}</strong>{limits.delay.value===0&&<small>A change takes effect when the proposer sends it. Every change is a public transaction.</small>}</>:<Unread what={FACT_NAMES.delay} chain={chain}/>}
      </Row>
      <Row label="Proposer multisig">
        {limits.proposer.ok?<><Addr chain={chain} a={limits.proposer.value}/><small>The only account that can schedule and run the admin's changes.</small></>:<Unread what={FACT_NAMES.proposer} chain={chain}/>}
      </Row>
      <Row label="Timelock">
        {limits.admin.ok?<Addr chain={chain} a={limits.admin.value}/>:<Unread what={FACT_NAMES.admin} chain={chain}/>}
      </Row>
    </dl>
  </section>;
}

const STATE_TEXT={waiting:'Waiting to start',active:'Active',expired:'Expired'};

function Watchers({limits,t}){
  const {chain}=limits;
  const at=chainNow(limits,t);
  const sameAdmin=limits.admin.ok&&limits.watcherAdmin.ok&&limits.admin.value.toLowerCase()===limits.watcherAdmin.value.toLowerCase();
  return <section className="lm-sec" aria-labelledby="lm-watch">
    <h2 id="lm-watch">{T.watchersHeading}</h2>
    <p className="lm-lead">{T.watchersLead}</p>
    {limits.watchers.ok?(limits.watchers.value.length===0?<p className="lm-body">{T.watchersNone}</p>
      :<ul className="lm-cards lm-watchers">{limits.watchers.value.map((w)=>{const s=watcherState(w,at);return <li key={w.watcher} className="lm-card lm-w">
        <div className="lm-wtop"><Addr chain={chain} a={w.watcher}/><span className={s==='active'?'lm-pill lm-on':'lm-pill'}>{STATE_TEXT[s]}</span></div>
        <dl className="lm-wdates"><div><dt>Active from</dt><dd>{utcDay(w.since)}</dd></div><div><dt>Expires on</dt><dd>{utcDay(w.until)}</dd></div></dl>
      </li>;})}</ul>)
      :<Unread what={FACT_NAMES.watchers} chain={chain}/>}
    <p className="lm-rule"><ShieldOff size={16} aria-hidden="true"/>{T.watcherRule}</p>
    <SourceLine chain={chain} r={WATCHER_REFS.delay}/>
    <SourceLine chain={chain} r={WATCHER_REFS.term}/>
    {limits.watcherAdmin.ok?<p className="lm-body">The watcher list is kept by {sameAdmin?'the same Timelock':<Addr chain={chain} a={limits.watcherAdmin.value}/>}.</p>:<Unread what={FACT_NAMES.watcherAdmin} chain={chain}/>}
  </section>;
}

function Picker({chain,onPick}){
  if(OFFERED.length<2)return null;
  return <div className="lm-nets" role="group" aria-label="Network">{OFFERED.map((c)=><button key={c.key} type="button" aria-pressed={c.key===chain.key} onClick={()=>onPick(c)}>{c.chainName}</button>)}</div>;
}

export default function Limits(){
  const [chain,setChain]=useState(()=>pick(OFFERED,savedChain()));
  const [state,reload]=useLimits(chain);
  const t=useClock();
  const choose=(c)=>{saveChain(c.key);setChain(c);};
  const limits=state.status==='ready'?state.limits:null;
  const facts=limits?[limits.expiry,limits.guardian,limits.armingPaused,limits.admin,limits.delay,limits.proposer,limits.adapters,limits.watcherAdmin,limits.watchers]:[];
  const live=Boolean(chain.router&&chain.alarmBook);
  const missing=facts.filter((f)=>!f.ok).length;
  return <Shell page="limits">
    <header className="wp-head lm-head">
      <div className="doc-eyebrow">{T.eyebrow}</div>
      <h1>{T.title}</h1>
      <p className="wp-abstract">{T.abstract(chain.chainName)}</p>
      <Picker chain={chain} onPick={choose}/>
    </header>
    <main className="lm-main">
      {!live?<div className="lm-note"><CircleHelp size={22} aria-hidden="true"/><div><h2>{T.noContracts.title}</h2><p>{T.noContracts.body}</p></div></div>
      :state.status==='loading'?<div className="lm-note" role="status" aria-live="polite"><div className="lm-spin" aria-hidden="true"/><div><h2>Reading {chain.chainName}…</h2><p>Asking the network about the contracts.</p></div></div>
      :state.status==='failed'?<div className="lm-note" role="status"><CircleHelp size={22} aria-hidden="true"/><div><h2>Could not read the chain</h2><p>The network did not answer, so nothing is shown. Nothing here was guessed.</p><button type="button" className="lm-retry" onClick={reload}><RefreshCw size={14} aria-hidden="true"/>{T.retry}</button></div></div>
      :<>
        {missing>0&&<div className="lm-note lm-partial" role="status"><CircleHelp size={22} aria-hidden="true"/><div><h2>{missing===1?'One fact could not be read':`${missing} facts could not be read`}</h2><p>They are marked below. The rest was read from the chain.</p><button type="button" className="lm-retry" onClick={reload}><RefreshCw size={14} aria-hidden="true"/>{T.retry}</button></div></div>}
        <Countdown limits={limits} t={t}/>
      </>}
      {live&&<Cannot chain={chain}/>}
      {live&&limits&&<><Admin limits={limits} t={t}/><Watchers limits={limits} t={t}/></>}
      <p className="lm-fine">{T.finePrint}</p>
    </main>
  </Shell>;
}
