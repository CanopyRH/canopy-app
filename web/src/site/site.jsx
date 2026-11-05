import React from 'react';
import {createRoot} from 'react-dom/client';
import Landing from './Landing.jsx';
import Docs from './Docs.jsx';
import Whitepaper from './Whitepaper.jsx';
import Roadmap from './Roadmap.jsx';
import content from '../copy/site.json';
import extra from './pages.gen.js';
import './fonts.css';

// guide.html is the old name for docs.html; both stay, so links already shared keep working.
// Pages from src/site/pages/ come in through pages.gen.js, which tools/build-web.sh writes. The built-in pages win on a clash.
const PAGES={...extra,docs:Docs,guide:Docs,whitepaper:Whitepaper,roadmap:Roadmap};
const root=document.getElementById('root');
const Page=PAGES[root.dataset.page];
createRoot(root).render(Page?<Page/>:<Landing content={content}/>);
