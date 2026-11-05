import React, {useEffect, useState} from 'react';
import {ArrowRight,Bell,Compass,Eye,FileCode,FileText,KeyRound,Receipt,Send,ShieldCheck,TriangleAlert} from 'lucide-react';
import content from '../copy/docs.json';
import {Action} from './Landing.jsx';
import {Shell,Prose} from './Shell.jsx';

const ICONS={compass:Compass,bell:Bell,receipt:Receipt,alert:TriangleAlert,shield:ShieldCheck,eye:Eye,'file-code':FileCode,key:KeyRound,send:Send};
// Docs live in one page and pick their section from the URL fragment, so links work from an IPFS gateway.
const current=()=>decodeURIComponent(location.hash.slice(1))||'how-it-works';

export default function Docs() {
  const[page,setPage]=useState(current);
  useEffect(()=>{const on=()=>{setPage(current());scrollTo(0,0);};addEventListener('hashchange',on);return()=>removeEventListener('hashchange',on);},[]);
  const doc=Object.hasOwn(content.pages,page)?content.pages[page]:null;
  useEffect(()=>{document.title=doc?`Canopy — ${doc.name}`:'Canopy — Docs';},[doc]);
  return <Shell page="docs">
    <div className="docs-layout">
      <aside>
        {content.groups.map((g)=><div className="pg-group" key={g.label}>
          <p>{g.label.toUpperCase()}</p>
          <nav aria-label={g.label}>{g.pages.map((id)=>{const item=content.pages[id];const Icon=ICONS[item.icon]||FileText;return <a aria-current={page===id?'page':undefined} href={'#'+id} key={id}><Icon size={16}/>{item.name}<ArrowRight size={14}/></a>;})}</nav>
        </div>)}
        <span className="docs-status"><i/> Live on Robinhood Chain</span>
      </aside>
      <main className="doc-article">
        {doc?<><div className="doc-eyebrow">DOCS / {doc.name.toUpperCase()}</div><Prose body={doc.body}/><div className="docs-end"><p>See it with a real wallet. Checking is read-only.</p><Action href="app.html">Open the app</Action></div></>
          :<><h1>This page isn’t here.</h1><p>Choose a page from the list, or go back to the website.</p><Action href="./">Back to Canopy</Action></>}
      </main>
    </div>
  </Shell>;
}
