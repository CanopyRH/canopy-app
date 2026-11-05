import React,{useEffect,useState} from 'react';
import {ArrowUpRight,Check,Copy,Share2,Timer,TriangleAlert,Hourglass,SearchX,WifiOff,CircleHelp} from 'lucide-react';
import {Shell} from '../Shell.jsx';
import {CHAINS} from '../../config';
import {loadReceipt,parseFragment,formatDelay,ReceiptError} from '../../receipt';
import './receipt.css';

const NOTES={
  pending:{icon:Hourglass,title:'This transaction is still pending',body:'It has not been included in a block yet. This page checks again every few seconds.'},
  missing:{icon:SearchX,title:'We could not find that transaction',body:'Check the link. The hash may be incomplete, or from another chain. Canopy runs on '+CHAINS.map((c)=>c.chainName).join(' and ')+'.'},
  failed:{icon:TriangleAlert,title:'That transaction failed',body:'It was included in a block but did not go through, so no exit happened.'},
  'not-exit':{icon:CircleHelp,title:'That is not a Canopy exit',body:'The transaction exists, but it does not include an exit from Canopy\'s router.'},
  rpc:{icon:WifiOff,title:'Could not reach the chain',body:'The network node did not answer. Nothing is wrong with the exit itself. Try again in a moment.'},
  unset:{icon:WifiOff,title:'Receipts are not set up here',body:'This build has no contract addresses.'},
  none:{icon:CircleHelp,title:'Paste a transaction hash to see its receipt',body:'Receipts are linked as receipt.html#0x followed by the 64-character transaction hash. You can find that link in the app after an exit.'},
  bad:{icon:TriangleAlert,title:'That is not a transaction hash',body:'A transaction hash starts with 0x and has 64 more characters, letters a to f and digits only.'},
};

const utc=(s)=>new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'UTC'}).format(new Date(s*1000))+' UTC';
const short=(a)=>a.slice(0,6)+'…'+a.slice(-4);

function useFragment(){
  const [frag,setFrag]=useState(()=>parseFragment(window.location.hash));
  useEffect(()=>{const on=()=>setFrag(parseFragment(window.location.hash));window.addEventListener('hashchange',on);return()=>window.removeEventListener('hashchange',on);},[]);
  return frag;
}

// Loads one receipt, and keeps trying while the transaction is pending.
function useReceipt(hash,chain){
  const [state,setState]=useState({status:hash?'loading':'idle'});
  useEffect(()=>{
    if(!hash||!chain){setState({status:'idle'});return;}
    let live=true,timer;
    const run=async()=>{
      try{const r=await loadReceipt(hash,chain);if(live)setState({status:'ok',receipt:r});}
      catch(e){
        const code=e instanceof ReceiptError?e.code:'rpc';
        if(!live)return;
        setState({status:'error',code});
        if(code==='pending')timer=setTimeout(run,5000);
      }
    };
    setState({status:'loading'});run();
    return()=>{live=false;clearTimeout(timer);};
  },[hash,chain]);
  return state;
}

function Note({code}){
  const n=NOTES[code]||NOTES.rpc,Icon=n.icon;
  return <div className="rc-note" role={code==='none'?undefined:'status'}><Icon size={22}/><div><h2>{n.title}</h2><p>{n.body}</p></div></div>;
}

function Actions({receipt}){
  const [copied,setCopied]=useState(false);
  const url=window.location.href;
  const copy=async()=>{
    try{await navigator.clipboard.writeText(url);}
    catch{const t=document.createElement('textarea');t.value=url;document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch{}t.remove();}
    setCopied(true);setTimeout(()=>setCopied(false),2000);
  };
  const share=()=>navigator.share({title:'Canopy exit receipt',text:'An exit Canopy ran for a vault position, read straight from the chain.',url}).catch(()=>{});
  return <div className="rc-actions">
    <button type="button" onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>}{copied?'Link copied':'Copy link'}</button>
    {typeof navigator.share==='function'&&<button type="button" onClick={share}><Share2 size={16}/>Share</button>}
    <a href={receipt.explorerUrl} target="_blank" rel="noopener noreferrer">View on explorer<ArrowUpRight size={16}/></a>
  </div>;
}

function Row({label,children}){return <div className="rc-row"><dt>{label}</dt><dd>{children}</dd></div>;}

function Card({r,chain}){
  const held=r.payouts.filter((p)=>p.held),paid=r.payouts.filter((p)=>!p.held);
  return <article className="rc-card" aria-label="Exit receipt">
    <header className="rc-top">
      <span className="rc-badge"><Check size={14}/>Exit complete</span>
      <span className="rc-id">Exit #{String(r.exitId)}</span>
    </header>
    <div className="rc-hero">
      <p className="rc-kicker">{paid.length?'Came back to the owner':'Nothing was paid out directly'}</p>
      {paid.map((p)=><p className="rc-amount" key={p.token.address}>{p.text}</p>)}
      {held.length>0&&<p className="rc-held">Held for the owner to claim: {held.map((p)=>p.text).join(', ')}</p>}
    </div>
    <dl className="rc-rows">
      <Row label="Vault">{r.vaultName||'Unknown vault'}{r.vault&&<small>{short(r.vault)}</small>}</Row>
      <Row label="What fired">{r.alarm?r.alarm.name:'No alarm. The owner chose Exit Now.'}</Row>
      {r.delaySeconds!==null&&<Row label="How fast"><span className="rc-fast"><Timer size={16}/>Exit ran {formatDelay(r.delaySeconds)} after the alarm fired</span></Row>}
      {r.viaAlarm&&r.delaySeconds===null&&<Row label="How fast">The fire time could not be read for this alarm.</Row>}
      {r.firedAt!==null&&<Row label="Alarm fired">{utc(r.firedAt)}</Row>}
      <Row label="Exit ran">{utc(r.blockTime)}<small>Block {String(r.blockNumber)}</small></Row>
    </dl>
    <footer className="rc-foot">
      <span>Paid to {short(r.owner)}</span>
      <span>{chain.chainName}</span>
    </footer>
  </article>;
}

export default function Receipt(){
  const frag=useFragment();
  const state=useReceipt(frag.kind==='ok'?frag.hash:null,frag.kind==='ok'?frag.chain:null);
  const code=frag.kind!=='ok'?frag.kind:state.status==='error'?state.code:null;
  return <Shell page="receipt">
    <header className="wp-head rc-head">
      <div className="doc-eyebrow">EXIT RECEIPT</div>
      <h1>What fired, how fast, what came back.</h1>
      <p className="wp-abstract">Every detail below is read straight from {frag.kind==='ok'?frag.chain.chainName:CHAINS.map((c)=>c.chainName).join(" or ")}. Canopy's servers are not involved, so this page works even if Canopy is down.</p>
    </header>
    <main className="rc-main">
      {state.status==='loading'&&frag.kind==='ok'&&<div className="rc-note" role="status" aria-live="polite"><div className="rc-spin" aria-hidden="true"/><div><h2>Reading the chain…</h2><p>Looking up the transaction.</p></div></div>}
      {code&&<Note code={code}/>}
      {frag.kind==='ok'&&state.status==='ok'&&<><Card r={state.receipt} chain={frag.chain}/><Actions receipt={state.receipt}/></>}
      <p className="rc-fine">A receipt shows what the chain recorded. It is not advice, and it says nothing about any future exit.</p>
    </main>
  </Shell>;
}
