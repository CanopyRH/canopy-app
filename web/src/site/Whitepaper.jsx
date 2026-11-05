import React, {useEffect, useState} from 'react';
import {Printer} from 'lucide-react';
import paper from '../copy/whitepaper.json';
import {Shell,Prose,Link} from './Shell.jsx';

const num=(i)=>String(i+1).padStart(2,'0');

export default function Whitepaper() {
  const[active,setActive]=useState(paper.sections[0].id);
  useEffect(()=>{
    // Highlights the section being read: the last heading that has passed the top third of the screen.
    const heads=paper.sections.map((s)=>document.getElementById(s.id)).filter(Boolean);
    const on=()=>{const line=innerHeight/3;let id=heads[0]?.id;for(const h of heads)if(h.getBoundingClientRect().top<line)id=h.id;setActive(id);};
    // The sections render after the browser looks for the #fragment, so a shared link to a section jumps here instead.
    const target=location.hash&&document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if(target)target.scrollIntoView({behavior:'instant'});
    on();addEventListener('scroll',on,{passive:true});return()=>removeEventListener('scroll',on);
  },[]);
  return <Shell page="whitepaper">
    <header className="wp-head">
      <div className="doc-eyebrow">{paper.eyebrow.toUpperCase()} · {paper.version.toUpperCase()}</div>
      <h1>{paper.title}</h1>
      <p className="wp-abstract">{paper.abstract}</p>
      <div className="wp-actions">
        {paper.links.map((l)=><Link key={l.label} href={l.href}>{l.label}</Link>)}
        <button type="button" onClick={()=>print()}><Printer size={15}/> Save as PDF</button>
      </div>
    </header>
    <div className="docs-layout wp-layout">
      <aside>
        <p className="pg-toc-label">CONTENTS</p>
        <nav className="wp-toc" aria-label="Contents">{paper.sections.map((s,i)=><a key={s.id} href={'#'+s.id} aria-current={active===s.id?'true':undefined}><span>{num(i)}</span>{s.title}</a>)}</nav>
      </aside>
      <main className="doc-article wp-article">
        {paper.sections.map((s,i)=><section key={s.id} aria-labelledby={s.id}>
          <h2 id={s.id}><span>{num(i)}</span>{s.title}</h2>
          <Prose body={s.body}/>
        </section>)}
      </main>
    </div>
  </Shell>;
}
