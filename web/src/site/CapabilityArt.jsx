import React from 'react';
import {Wallet, Layers3, Droplets, LockKeyhole, Radar, KeyRound, Bell, Check, ArrowUpRight, FileCheck2} from 'lucide-react';

// Illustrations are decorative: product facts live in the adjacent real text.
export default function CapabilityArt({index,Mark}) {
  return <div className={`capability-art capability-art-${index}`} aria-hidden="true">
    {index===0&&<div className="workflow-art">
      <span className="workflow-core"><Mark/></span>
      <div className="workflow-stem"/>
      <div className="workflow-links"/>
      <div className="workflow-nodes">{[KeyRound,Layers3,Droplets].map((Icon,i)=><span key={i}><Icon size={27} strokeWidth={1.5}/></span>)}</div>
      <div className="workflow-rails"><i/><i/><i/></div>
      <div className="workflow-nodes workflow-secondary">{[LockKeyhole,Radar,Wallet].map((Icon,i)=><span key={i}><Icon size={24} strokeWidth={1.4}/></span>)}</div>
    </div>}
    {index===1&&<div className="signal-bubbles">
      <div><span className="bubble-avatar"><Mark/></span><span className="typing-bubble"><i/><i/><i/></span></div>
      <div className="bubble-out"><span>Share price falls 0.5% below its high</span><span className="bubble-avatar chrome-icon"><Bell size={17}/></span></div>
      <div><span className="bubble-avatar"><Mark/></span><span className="bubble-in">Your selected alarm</span></div>
    </div>}
    {index===2&&<div className="harbour-stack">
      <div className="harbour-option harbour-back"><span className="chrome-icon"><Layers3 size={20}/></span><b>Vault asset</b><small>Such as USDC</small></div>
      <div className="harbour-option harbour-front"><span className="chrome-icon"><Wallet size={28}/></span><b>Your wallet</b><small><Check size={10}/> Owner only</small></div>
      <div className="harbour-option harbour-back"><span className="chrome-icon"><Droplets size={20}/></span><b>No swap</b><small>In v1</small></div>
    </div>}
    {index===3&&<div className="receipt-graph">
      <div className="receipt-grid"><i/><i/><i/><i/><i/><i/></div>
      <svg viewBox="0 0 320 126" preserveAspectRatio="none"><defs><linearGradient id="receipt-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#42454b"/><stop offset="100%" stopColor="#d5d6d9" stopOpacity="0"/></linearGradient></defs><path d="M0 70L15 51 32 62 49 48 65 53 81 27 98 37 115 26 130 42 147 29 164 62 180 56 196 69 214 53 233 66 253 52 273 60 291 77 310 74 320 82V126H0Z" fill="url(#receipt-fill)"/><path d="M0 70L15 51 32 62 49 48 65 53 81 27 98 37 115 26 130 42 147 29 164 62 180 56 196 69 214 53 233 66 253 52 273 60 291 77 310 74 320 82" fill="none" stroke="#71757d" strokeWidth="1.5"/></svg>
      <span className="receipt-label"><FileCheck2 size={11}/> Exit transaction</span><i className="receipt-pin"/>
    </div>}
    {index===4&&<div className="permission-orbits">
      <i/><i/><i/><span className="permission-core"><Mark/></span>
      <span className="orbit-key orbit-key-a"><LockKeyhole size={18}/></span><span className="orbit-key orbit-key-b"><KeyRound size={18}/></span><span className="orbit-key orbit-key-c"><ArrowUpRight size={20}/></span>
    </div>}
  </div>;
}
