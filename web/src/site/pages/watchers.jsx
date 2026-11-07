import React,{useEffect,useState} from 'react';
import {CONFIG} from '../../config';
import {parseReport,shortAddress,ago,utc,countsLine,watchersUrl} from '../../watchers';
import {Shell,Link} from '../Shell.jsx';
import './watchers.css';

const REPO='https://github.com/CanopyRH/canopy-app';

function Attestations({rows,now}) {
  return <div className="doc-table"><table>
    <thead><tr><th>Signed</th><th>Alarm key</th><th>Result</th></tr></thead>
    <tbody>{rows.map((a)=><tr key={a.key+a.evidence+a.deadline}>
      <td title={utc(a.attestedAt)}>{ago(now,a.attestedAt)}</td>
      <td><code>{shortAddress(a.key)}</code></td>
      <td>{a.matched&&a.firedAt!==null?<span className="wt-yes">Matched an alarm that fired {utc(a.firedAt)}</span>:<span className="wt-no">No alarm fired</span>}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Watcher({w,now,days}) {
  return <li className="wt-card">
    <header>
      <Link href={CONFIG.explorer+'/address/'+w.address}><code className="wt-addr">{w.address}</code></Link>
      <span className="wt-tag">{w.status==='pending'?'Approved, not counting yet':w.source==='chain'?'Approved on chain':'Listed in this service’s settings'}</span>
    </header>
    <dl>
      <div><dt>Last signed</dt><dd>{ago(now,w.lastAttestedAt)}{w.lastAttestedAt!==null&&<small> · {utc(w.lastAttestedAt)}</small>}</dd></div>
      <div><dt>Last {days} days</dt><dd>{countsLine(w,days)}</dd></div>
      {w.approvedAt!==null&&<div><dt>Approved</dt><dd>{utc(w.approvedAt)}</dd></div>}
      {w.status==='pending'&&w.activeFrom!==null&&<div><dt>Counts from</dt><dd>{utc(w.activeFrom)}</dd></div>}
      {w.expiresAt!==null&&<div><dt>Approval ends</dt><dd>{utc(w.expiresAt)}</dd></div>}
    </dl>
    {w.recent.length>0&&<details>
      <summary>See the {w.recent.length<w.attestations30d?'latest '+w.recent.length:w.recent.length} {w.recent.length===1?'signature':'signatures'}</summary>
      <Attestations rows={w.recent} now={now}/>
    </details>}
  </li>;
}

export default function Watchers() {
  const [state,setState]=useState({status:'loading'});
  useEffect(()=>{
    let live=true;
    fetch(watchersUrl(CONFIG.apiUrl))
      .then((r)=>{if(!r.ok)throw new Error('status '+r.status);return r.json();})
      .then((j)=>{const report=parseReport(j);if(!live)return;setState(report?{status:'ok',report}:{status:'error'});})
      .catch(()=>{if(live)setState({status:'error'});});
    return ()=>{live=false;};
  },[]);
  const {report}=state;
  return <Shell page="watchers">
    <header className="wp-head rm-head">
      <div className="doc-eyebrow">WATCHERS</div>
      <h1>Who confirms an alarm</h1>
      <p className="wp-abstract">Some alarms fire only when 2 approved watchers sign. A watcher can&rsquo;t move funds, and one watcher can&rsquo;t fire an alarm alone. A new watcher only counts 2 days after it is approved, and every approval ends within a year unless it is renewed. This page lists every approved watcher, when its approval ends, and what it has signed.</p>
    </header>
    <main className="wt-main">
      {state.status==='loading'&&<p className="wt-note" role="status">Loading watchers…</p>}
      {state.status==='error'&&<p className="wt-note" role="alert">We couldn&rsquo;t load the watchers just now. Try again in a minute.</p>}
      {report&&report.watchers.length===0&&<p className="wt-note">No watchers are listed yet.</p>}
      {report&&report.watchers.length>0&&<>
        <p className="wt-count">{report.watchers.length} approved {report.watchers.length===1?'watcher':'watchers'}</p>
        <ul className="wt-list">{report.watchers.map((w)=><Watcher key={w.address} w={w} now={report.generatedAt} days={report.windowDays}/>)}</ul>
        <aside className="wt-help">
          <h2>How to read this</h2>
          <ul>
            <li><strong>Last signed</strong> is when this service received the watcher&rsquo;s latest signature. A watcher signs only when a report and an on-chain signal agree, so &ldquo;never&rdquo; or a long gap is normal on a quiet month. It is not a sign that the watcher is down.</li>
            <li><strong>Matched an alarm that fired</strong> means an alarm for the same key fired on chain while that signature was still valid. <strong>No alarm fired</strong> usually means fewer than 2 watchers signed, so nothing fired. It isn&rsquo;t an accusation.</li>
            <li>The figures come from this service&rsquo;s own records, so a signature that never reached it isn&rsquo;t counted.</li>
          </ul>
        </aside>
      </>}
    </main>
    <div className="rm-end">
      <p>Want to run a watcher so that confirmation doesn&rsquo;t depend on one team? Read <Link href={REPO+'/blob/main/WATCHERS.md'}>the guide</Link> and <Link href={REPO+'/issues/new?template=watcher-application.yml'}>apply on GitHub</Link>.</p>
    </div>
  </Shell>;
}
