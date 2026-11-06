import React,{useState} from 'react';
import {Check,Copy,FileJson,FileText} from 'lucide-react';
import {Shell,Link} from '../Shell.jsx';
import {API,EXAMPLES,NOT_FOR_AGENTS,ROUTES,RULES} from '../agentsContent.js';
import './agents.css';

function CopyBlock({code,label}) {
  const [done,setDone]=useState(false);
  const copy=async()=>{
    try{await navigator.clipboard.writeText(code);setDone(true);setTimeout(()=>setDone(false),1800);}
    catch{/* the text stays selectable */}
  };
  return <div className="ag-code">
    <button type="button" onClick={copy} aria-label={`Copy ${label}`}>{done?<Check size={15} aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}{done?'Copied':'Copy'}</button>
    <pre><code>{code}</code></pre>
  </div>;
}

export default function Agents() {
  return <Shell page="agents">
    <header className="wp-head rm-head ag-head">
      <div className="doc-eyebrow">FOR AGENT BUILDERS</div>
      <h1>Build on Canopy, with the rules built in.</h1>
      <p className="wp-abstract">A read-only API and calldata helpers for agents and SDKs. It builds the transaction. The owner's wallet signs it. Nothing here can send funds anywhere but back to the owner.</p>
      <div className="wp-actions">
        <a href={`${API}/openapi.json`} target="_blank" rel="noopener noreferrer"><FileJson size={16} aria-hidden="true"/>OpenAPI 3.1 spec</a>
        <a href="llms.txt"><FileText size={16} aria-hidden="true"/>llms.txt</a>
      </div>
    </header>
    <main className="ag-main">
      <section aria-labelledby="ag-rules">
        <h2 id="ag-rules">The rules</h2>
        <p className="ag-lead">They hold on-chain and in the API. Your agent should hold to them too.</p>
        <ol className="ag-rules">{RULES.map((r)=><li key={r.title}><h3>{r.title}</h3><p>{r.body}</p></li>)}</ol>
        <aside className="ag-warn" aria-label="Disarm rights">
          <strong>Never give an agent disarm rights.</strong>
          <p>An agent that can disarm can leave an owner unprotected, and a stolen or confused agent would do it without anyone noticing. Keep Disarm and Disarm All behind the owner's own wallet. Arm and tighten are the most an agent needs.</p>
        </aside>
      </section>

      <section aria-labelledby="ag-base">
        <h2 id="ag-base">Base URL</h2>
        <CopyBlock code={API} label="the base URL"/>
        <p className="ag-note">Canopy runs on Robinhood Chain first. The spec's <code>servers</code> field and <code>/llms.txt</code> name the chain and contract addresses this API answers for.</p>
      </section>

      <section aria-labelledby="ag-routes">
        <h2 id="ag-routes">Routes</h2>
        <div className="doc-table"><table>
          <thead><tr><th>Route</th><th>What it does</th></tr></thead>
          <tbody>{ROUTES.map((r)=><tr key={r.path}><td><code>GET {r.path}</code></td><td>{r.note}</td></tr>)}</tbody>
        </table></div>
        <p className="ag-note">Every route is a GET and is limited per client address. Errors are JSON with an <code>error</code> sentence and, on calldata routes, a stable <code>code</code>. Full parameters, schemas and error lists are in the <a href={`${API}/openapi.json`} target="_blank" rel="noopener noreferrer">OpenAPI spec</a>.</p>
      </section>

      <section aria-labelledby="ag-ex">
        <h2 id="ag-ex">Examples</h2>
        {EXAMPLES.map((e)=><article key={e.id} className="ag-ex">
          <h3>{e.title}</h3>
          <p>{e.body}</p>
          <CopyBlock code={e.code} label={e.title}/>
        </article>)}
      </section>

      <section aria-labelledby="ag-owner">
        <h2 id="ag-owner">For owners' screens only</h2>
        <p className="ag-note">{NOT_FOR_AGENTS}</p>
      </section>

      <p className="ag-end">Canopy is software. It tries to exit a position when an alarm fires, and it can fail. The contracts have not had an external audit. <Link href="docs.html">Read the docs</Link> for how alarms and exits work.</p>
    </main>
  </Shell>;
}
