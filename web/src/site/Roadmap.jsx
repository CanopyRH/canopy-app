import React from 'react';
import {CheckCircle2,CircleDashed,CircleDot,Sparkles} from 'lucide-react';
import roadmap from '../copy/roadmap.json';
import {Action} from './Landing.jsx';
import {Shell,inline} from './Shell.jsx';

const ICONS={live:CheckCircle2,next:CircleDot,later:CircleDashed,exploring:Sparkles};

export default function Roadmap() {
  return <Shell page="roadmap">
    <header className="wp-head rm-head">
      <div className="doc-eyebrow">{roadmap.eyebrow.toUpperCase()}</div>
      <h1>{roadmap.title}</h1>
      <p className="wp-abstract">{roadmap.intro}</p>
      {roadmap.draft&&<p className="rm-draft">Draft for review. Not final.</p>}
    </header>
    <main className="rm-board">
      {roadmap.phases.map((phase)=>{const Icon=ICONS[phase.status]||CircleDot;return <section className={'rm-phase rm-'+phase.status} key={phase.id} aria-labelledby={'rm-'+phase.id}>
        <header><Icon size={18}/><h2 id={'rm-'+phase.id}>{phase.label}</h2>{phase.note&&<small>{phase.note}</small>}</header>
        <ol>{phase.items.map((item)=><li key={item.title}>
          <h3>{item.title}</h3>
          <p>{inline(item.body)}</p>
          {item.tags&&<div className="rm-tags">{item.tags.map((t)=><span key={t}>{t}</span>)}</div>}
        </li>)}</ol>
      </section>;})}
    </main>
    <div className="rm-end"><p>Want something sooner, or something that isn't here? {inline('[Open an issue on GitHub](https://github.com/CanopyRH/canopy-app/issues).')}</p><Action href="docs.html">Read the docs</Action></div>
  </Shell>;
}
