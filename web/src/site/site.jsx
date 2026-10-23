import React from 'react';
import {createRoot} from 'react-dom/client';
import Landing from './Landing.jsx';
import Docs from './Docs.jsx';
import content from '../copy/site.json';
import './fonts.css';

const root=document.getElementById('root');
createRoot(root).render(root.dataset.page==='guide'?<Docs/>:<Landing content={content}/>);
