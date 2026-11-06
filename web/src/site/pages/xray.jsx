import React,{useEffect,useState} from 'react';
import {CONFIG} from '../../config';
import {XRAY_COPY as C,VAULT_PARAM,imageUrl,intentUrl,shareText,shareUrl} from '../../copy/xray';
import {Shell} from '../Shell.jsx';
import '../xray.css';

// Reads ?vault=0x... and shows that vault's X-ray card, drawn by the API. The card holds no wallet address.
export default function Xray() {
  const api=CONFIG.apiUrl;
  const param=new URLSearchParams(window.location.search).get('vault')?.trim()||'';
  const vault=VAULT_PARAM.test(param)?param.toLowerCase():null;
  const [input,setInput]=useState(param);
  const [error,setError]=useState(param&&!vault?C.badAddress:'');
  const [facts,setFacts]=useState(null);
  const [state,setState]=useState(vault?'loading':'idle');
  const [note,setNote]=useState('');

  useEffect(()=>{
    if(!vault||!api)return;
    let live=true;
    fetch(`${shareUrl(api,vault)}.json`).then(async(r)=>{
      if(!live)return;
      if(r.status===404)return setState('unknown');
      if(!r.ok)return setState('failed');
      setFacts(await r.json());setState('ready');
    }).catch(()=>live&&setState('failed'));
    return()=>{live=false;};
  },[vault,api]);

  // The page's CSP forbids form posts, so a submit just moves to the same page with the vault in the address.
  const submit=(e)=>{
    e.preventDefault();
    const v=input.trim();
    if(!VAULT_PARAM.test(v))return setError(C.badAddress);
    window.location.search=`?vault=${v.toLowerCase()}`;
  };
  const link=vault&&api?shareUrl(api,vault):'';
  const copy=async()=>{
    try{await navigator.clipboard.writeText(link);setNote(C.copied);}catch{setNote(C.copyFailed);}
  };

  return <Shell page="xray">
    <main className="xr-main" id="main">
      <h1>{C.title}</h1>
      <p>{C.intro}</p>
      {!api&&<p className="xr-msg">{C.unavailable}</p>}
      <form className="xr-form" onSubmit={submit}>
        <input aria-label={C.inputLabel} placeholder={C.placeholder} value={input} onChange={(e)=>{setInput(e.target.value);setError('');}} autoComplete="off" spellCheck="false"/>
        <button className="xr-btn" type="submit">{C.button}</button>
      </form>
      {error&&<p className="xr-msg" role="alert">{error}</p>}
      {!vault&&<div><p>{C.or}</p><div className="xr-list">{CONFIG.vaults.map((v)=><a key={v.address} href={`xray.html?vault=${v.address.toLowerCase()}`}>{v.name}</a>)}</div></div>}
      {vault&&api&&state==='loading'&&<p className="xr-msg">{C.loading}</p>}
      {vault&&state==='unknown'&&<p className="xr-msg">{C.unknown}</p>}
      {vault&&state==='failed'&&<p className="xr-msg">{C.failed}</p>}
      {vault&&api&&state==='ready'&&<>
        <img className="xr-card" src={imageUrl(api,vault)} alt={C.alt} width="1200" height="675"/>
        <div className="xr-actions">
          <a className="xr-btn" href={intentUrl(shareText(facts),link)} target="_blank" rel="noopener noreferrer">{C.post}</a>
          <button className="xr-btn light" type="button" onClick={copy}>{C.copy}</button>
          <a className="xr-btn light" href="app.html">{C.openApp}</a>
        </div>
        <p className="xr-link" role="status">{note&&<strong>{note}. </strong>}{link}</p>
      </>}
      <p className="xr-note">{C.note}</p>
    </main>
  </Shell>;
}
