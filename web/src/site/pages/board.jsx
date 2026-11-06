import React,{useEffect,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {CONFIG} from '../../config';
import copy from '../../copy/board.json';
import {Shell} from '../Shell.jsx';
import {REFRESH_MS,ago,duration,intentUrl,tweetText,usd} from '../board.ts';
import '../board.css';

// TODO: link to the exit log (exits.html) and the status page (status.html) from here once they are on main.

const money=usd;

function Stat({label,value,note,big=false}) {
  return <div className={'bd-stat'+(big?' bd-big':'')}><strong>{value}</strong><span>{label}</span>{note&&<small>{note}</small>}</div>;
}

export default function Board() {
  const [data,setData]=useState(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let stop=false,loaded=false;
    const load=async()=>{
      if(document.hidden&&loaded)return;
      try{
        const r=await fetch(`${CONFIG.apiUrl}/board`);
        if(!r.ok)throw new Error('bad status');
        const j=await r.json();
        if(!stop){loaded=true;setData(j);setFailed(false);}
      }catch{if(!stop)setFailed(true);}
    };
    load();
    const id=setInterval(load,REFRESH_MS);
    return()=>{stop=true;clearInterval(id);};
  },[]);

  const empty=data&&data.armed.positions===0;
  const t=data?.exits.secondsToExit;
  const text=data?tweetText(data):null;
  return <Shell page="board">
    <header className="wp-head bd-head">
      <div className="doc-eyebrow">{copy.eyebrow.toUpperCase()}</div>
      {data?<h1 className="bd-pitch" aria-live="polite">
        <span>{money(data.armed.value)}</span> {copy.pitch}.
        {t?.fastest!=null&&<> {copy.fastest}: <span>{duration(t.fastest)}</span>.</>}
      </h1>:<h1 className="bd-pitch">{failed?copy.status.failed:copy.status.loading}</h1>}
      <p className="wp-abstract">{empty?copy.emptyIntro:copy.intro}</p>
      <div className="wp-actions">
        {text&&<a href={intentUrl(text)} target="_blank" rel="noopener noreferrer">{copy.share.button}<ArrowUpRight size={15} aria-hidden="true"/></a>}
        {text&&<small className="bd-hint">{copy.share.hint}</small>}
      </div>
    </header>
    {data&&<main className="bd-main">
      <section className="bd-stats" aria-label="Numbers">
      <div className="bd-bigs">
        <Stat big label={copy.stats.positions} value={data.armed.positions.toLocaleString('en-US')}/>
        <Stat big label={copy.stats.wallets} value={data.armed.wallets.toLocaleString('en-US')}/>
        <Stat big label={copy.stats.returned} value={money(data.exits.allTime.value)} note={copy.notes.returned}/>
      </div>
      <div className="bd-grid">
        <Stat label={copy.stats.exits24h} value={data.exits.last24h.count.toLocaleString('en-US')} note={money(data.exits.last24h.value)}/>
        <Stat label={copy.stats.exits7d} value={data.exits.last7d.count.toLocaleString('en-US')} note={money(data.exits.last7d.value)}/>
        <Stat label={copy.stats.exitsAll} value={data.exits.allTime.count.toLocaleString('en-US')} note={money(data.exits.allTime.value)}/>
        <Stat label={copy.stats.fastestTime} value={duration(t.fastest)} note={t.fastest===null?copy.notes.noExit:copy.notes.time}/>
        <Stat label={copy.stats.median} value={duration(t.median)} note={t.median===null?copy.notes.noExit:copy.notes.time}/>
      </div>
      </section>

      <section className="bd-card" aria-labelledby="bd-vaults">
        <h2 id="bd-vaults">{copy.vaults.title}</h2>
        {data.armed.topVaults.length===0?<p className="bd-empty">{copy.vaults.empty}</p>:<ol className="bd-vaults">
          <li className="bd-vhead" aria-hidden="true"><span>{copy.vaults.name}</span><span>{copy.vaults.value}</span><span>{copy.vaults.positions}</span></li>
          {data.armed.topVaults.map((v)=><li key={v.vault}><span className="bd-name">{v.name}</span><span>{money(v.value)}</span><span>{v.positions.toLocaleString('en-US')}</span></li>)}
        </ol>}
      </section>

      <section className="bd-card" aria-labelledby="bd-latest">
        <h2 id="bd-latest">{copy.latest.title}</h2>
        {data.exits.latest.length===0?<p className="bd-empty">{copy.latest.empty}</p>:<ul className="bd-exits">
          {data.exits.latest.map((e)=><li key={e.tx}>
            <div className="bd-exit-top"><strong>{e.vault}</strong><span>{money(e.amount)}</span></div>
            <div className="bd-exit-meta">
              <span>{e.alarm||'Exit'}</span>
              <span>{copy.latest.time}: {duration(e.secondsToExit)}</span>
              <span>{ago(e.at,data.generatedAt)}</span>
              {e.txUrl&&<a href={e.txUrl} target="_blank" rel="noopener noreferrer">{copy.latest.view}<ArrowUpRight size={13} aria-hidden="true"/></a>}
            </div>
          </li>)}
        </ul>}
      </section>

      <p className="bd-foot">{copy.footnote}</p>
      {failed&&<p className="bd-foot" role="status">{copy.status.failed}</p>}
    </main>}
  </Shell>;
}
