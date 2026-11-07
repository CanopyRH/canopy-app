import React from 'react';
import {ArrowUpRight} from 'lucide-react';
import {Mark} from './Landing.jsx';
import './docs.css';
import './pages.css';

// The reading pages (docs, whitepaper, roadmap) share this frame, so moving between them feels like one site.
const PAGES=[{id:'docs',label:'Docs',href:'docs.html'},{id:'whitepaper',label:'Whitepaper',href:'whitepaper.html'},{id:'roadmap',label:'Roadmap',href:'roadmap.html'},{id:'board',label:'Board',href:'board.html'}];
const FOOTER=[{label:'Research tools',href:'research.html'},{label:'Website',href:'./'},{label:'App',href:'app.html'},{label:'Armed board',href:'board.html'},{label:"What Canopy can't do",href:'limits.html'},{label:'For agents',href:'agents.html'},{label:'Telegram alerts',href:'https://t.me/CanopyAlerts_Bot'},{label:'Source code',href:'https://github.com/CanopyRH/canopy-app'}];

export function Shell({page,children}) {
  return <div className="docs-page">
    <a className="pg-skip" href="#content">Skip to content</a>
    <header className="pg-nav">
      <a className="docs-brand" href="./" aria-label="Canopy home"><Mark/><span>Canopy</span></a>
      <nav className="pg-links" aria-label="Pages">{PAGES.map((p)=><a key={p.id} href={p.href} aria-current={p.id===page?'page':undefined}>{p.label}</a>)}</nav>
      <a className="pg-app" href="app.html">Open app <ArrowUpRight size={16}/></a>
    </header>
    <div id="content">{children}</div>
    <footer className="pg-footer">
      <nav aria-label="More">{FOOTER.map((l)=><Link key={l.label} href={l.href}>{l.label}</Link>)}</nav>
      <p>Canopy is software. It tries to exit when your alarms fire. It promises no outcome and does not pay for losses.</p>
      <small>© 2026 Canopy · DeFi auto-exit</small>
    </footer>
  </div>;
}

export function Link({href,children}) {
  const external=/^https?:/.test(href);
  return <a href={href} {...(external?{target:'_blank',rel:'noopener noreferrer'}:{})}>{children}{external&&<ArrowUpRight className="pg-ext" size={13} aria-hidden="true"/>}</a>;
}

// Inline marks: **bold**, `code` and [text](url). Built as React nodes, never as HTML.
const MARK=/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
export function inline(text) {
  return text.split(MARK).filter(Boolean).map((t,i)=>{
    if(t.startsWith('**')&&t.endsWith('**'))return <strong key={i}>{t.slice(2,-2)}</strong>;
    if(t.startsWith('`')&&t.endsWith('`'))return <code key={i}>{t.slice(1,-1)}</code>;
    const m=/^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
    return m?<Link key={i} href={m[2]}>{m[1]}</Link>:t;
  });
}

// A small Markdown subset: headings, tables, lists and paragraphs, split on blank lines.
export function Prose({body}) {
  return body.split(/\n\s*\n/).map((block,i)=>{
    const lines=block.split('\n');
    if(block.startsWith('### '))return <h3 key={i}>{inline(block.slice(4))}</h3>;
    if(block.startsWith('## '))return <h2 key={i}>{inline(block.slice(3))}</h2>;
    if(block.startsWith('# '))return <h1 key={i}>{inline(block.slice(2))}</h1>;
    if(block.startsWith('|')){
      const rows=lines.filter((_,n)=>n!==1).map((l)=>l.split('|').slice(1,-1).map((s)=>s.trim()));
      return <div className="doc-table" key={i}><table><thead><tr>{rows[0].map((t,k)=><th key={k}>{inline(t)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r,k)=><tr key={k}>{r.map((t,j)=><td key={j}>{inline(t)}</td>)}</tr>)}</tbody></table></div>;
    }
    if(lines.every((l)=>l.startsWith('- ')))return <ul key={i}>{lines.map((l,k)=><li key={k}>{inline(l.slice(2))}</li>)}</ul>;
    if(lines.every((l)=>/^\d+\. /.test(l)))return <ol key={i}>{lines.map((l,k)=><li key={k}>{inline(l.replace(/^\d+\. /,''))}</li>)}</ol>;
    return <p key={i}>{inline(block)}</p>;
  });
}
