import { LandscapeRenderer } from './renderer.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const glCanvas = $('#glCanvas');
const overlay = $('#overlayCanvas');
const overlayCtx = overlay.getContext('2d');
const viewport = $('#viewport');
const MAX_2D_ZOOM=260;
const MIN_3D_DISTANCE=.52;
let renderer;
try { renderer = new LandscapeRenderer(glCanvas); }
catch (error) { $('#emptyState').hidden=false; $('#emptyState strong').textContent='WebGL2 is unavailable'; $('#emptyState span').textContent=error.message; throw error; }

const palettes = [
  { application:'#1fbf8c', library:'#28aa8b', test:'#c7a62e', generated:'#cc7741', vendor:'#4e83bc', platform:'#d05492', docs:'#8d9561', unknown:'#65706a' },
  { application:'#48a9e6', library:'#7874db', test:'#e6a04b', generated:'#d6627c', vendor:'#45b39d', platform:'#b781d4', docs:'#9ca35c', unknown:'#697277' },
  { application:'#87b95d', library:'#39a5a0', test:'#e2bf52', generated:'#e37d52', vendor:'#527ac2', platform:'#c76699', docs:'#a4a4a4', unknown:'#6b706d' },
];
let paletteIndex=0;
let files=[];
let edges=[];
let layoutItems=[];
let directoryRects=[];
let fileById=new Map();
let layoutById=new Map();
let referenceDegree=new Map();
let edgesByFile=new Map();
let sceneStats={definitions:0,totalLines:0,known:0,inferred:0,layers:new Map()};
let spatialGrid=new Map();
let visibleScreenItems=[];
let overviewCanvas=null,overviewContext=null,overviewIndex=0;
let codeTextureBytes=0;
const codeTextureLru=new Map(),codeTextureBudget=192*1024*1024,overviewScale=3;
let selected=null;
let history=[];
let searchHits=[];
let expandedCoverageLayer=null;
let coverageActiveIndex=-1;
let cameraAnimation=null;
let currentSnapshot=null;
let currentName='';
let currentMetric='lines';
let showCode=true;
let showLegend=false;
let dirty=true;
let pointer={down:false,x:0,y:0,startX:0,startY:0,action:'orbit',id:null};
let lastFrame=performance.now(), frameSamples=[];

const layerLabels = { application:'Application',library:'Libraries',test:'Tests',generated:'Generated',vendor:'Vendor',platform:'Platform',docs:'Documentation',unknown:'Other' };

function toRgb(hex){const value=parseInt(hex.slice(1),16);return[((value>>16)&255)/255,((value>>8)&255)/255,(value&255)/255];}
function fileWeight(file){
  if(currentMetric==='references'){
    const degree=referenceDegree.get(file.id)||0;
    return Math.max(1,degree*55+(file.symbolCount??file.symbols?.length??0)*7);
  }
  return Math.max(1,file.lines);
}

function makeTree(list){
  // Repositories frequently keep source files at their root. Root participates
  // in the same layout contract as every child directory.
  const root={name:currentName,path:'',children:new Map(),files:[],weight:0,depth:0};
  for(const file of list){
    const parts=file.path.split('/'), filename=parts.pop(); let node=root;
    for(const part of parts){
      if(!node.children.has(part)) node.children.set(part,{name:part,path:node.path?`${node.path}/${part}`:part,children:new Map(),files:[],weight:0,depth:node.depth+1});
      node=node.children.get(part);
    }
    node.files.push({name:filename,file,weight:fileWeight(file)});
  }
  function weigh(node){
    let weight=0;const layers=new Map();
    for(const item of node.files||[]){weight+=item.weight;const layer=item.file.layer in layerLabels?item.file.layer:'unknown';layers.set(layer,(layers.get(layer)||0)+item.weight);}
    for(const child of node.children.values()){const childWeight=weigh(child);weight+=childWeight;layers.set(child.layer,(layers.get(child.layer)||0)+childWeight);}
    node.weight=weight;node.layer=[...layers.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'unknown';return weight;
  }
  weigh(root); return root;
}

function squarifiedLayout(entries,x,y,w,h,depth,output){
  if(!entries.length||w<=0||h<=0)return;
  const total=entries.reduce((sum,entry)=>sum+Math.max(.0001,entry.weight),0),scale=w*h/total;
  const remaining=entries.map(entry=>({entry,area:Math.max(.0001,entry.weight)*scale}));
  const worst=(row,side)=>{
    if(!row.length)return Infinity;
    const sum=row.reduce((value,item)=>value+item.area,0),largest=Math.max(...row.map(item=>item.area)),smallest=Math.min(...row.map(item=>item.area)),sideSquared=side*side;
    return Math.max(sideSquared*largest/(sum*sum),(sum*sum)/(sideSquared*smallest));
  };
  const place=row=>{
    const area=row.reduce((value,item)=>value+item.area,0);
    if(w>=h){
      const rowWidth=Math.min(w,area/Math.max(.0001,h));let rowY=y;
      for(const item of row){const itemHeight=item.area/Math.max(.0001,rowWidth);output(item.entry,x,rowY,rowWidth,itemHeight,depth);rowY+=itemHeight;}
      x+=rowWidth;w=Math.max(0,w-rowWidth);
    }else{
      const rowHeight=Math.min(h,area/Math.max(.0001,w));let rowX=x;
      for(const item of row){const itemWidth=item.area/Math.max(.0001,rowHeight);output(item.entry,rowX,y,itemWidth,rowHeight,depth);rowX+=itemWidth;}
      y+=rowHeight;h=Math.max(0,h-rowHeight);
    }
  };
  let row=[];
  while(remaining.length){
    const next=remaining[0],side=Math.max(.0001,Math.min(w,h));
    if(!row.length||worst([...row,next],side)<=worst(row,side)){row.push(remaining.shift());}
    else{place(row);row=[];}
  }
  if(row.length)place(row);
}

function computeLayout(){
  const root=makeTree(files); layoutItems=[];directoryRects=[];
  function visit(node,x,y,w,h,depth){
    directoryRects.push({node,x,y,w,h,depth});
    const pad=Math.min(3.2,1.2+depth*.35,w*.07,h*.07),header=Math.min(8,Math.max(0,h*.05)),ix=x+pad,iy=y+pad+header,iw=Math.max(.01,w-pad*2),ih=Math.max(.01,h-pad*2-header);
    const values=[...node.children.values(),...(node.files||[])],total=values.reduce((sum,value)=>sum+value.weight,0);
    // A file should be compared with its siblings, not visually erased by the
    // aggregate weight of a huge neighboring subtree. The local floor keeps
    // every entry readable while leaving at least 87.5% of each region fully
    // proportional to the selected metric.
    const floor=total/Math.max(1,values.length*8);
    const entries=values.map(value=>({value,weight:Math.max(value.weight,floor)})).sort((a,b)=>b.weight-a.weight);
    squarifiedLayout(entries,ix,iy,iw,ih,depth,(wrapped,rx,ry,rw,rh)=>{
      const entry=wrapped.value;
      if(entry.file){
        const inset=Math.min(1,Math.min(rw,rh)*.08),layer=entry.file.layer in palettes[paletteIndex]?entry.file.layer:'unknown';
        layoutItems.push({...entry.file,x:rx+inset,y:ry+inset,w:Math.max(.1,rw-inset*2),h:Math.max(.1,rh-inset*2),color:toRgb(palettes[paletteIndex][layer]),height:4+Math.log2(entry.file.lines+entry.file.complexity*5)*5});
      }else visit(entry,rx,ry,rw,rh,depth+1);
    });
  }
  visit(root,0,0,1000,680,0);
  layoutById=new Map(layoutItems.map(item=>[item.id,item]));buildSpatialGrid();resetCodeCaches();
  renderer.setData(layoutItems);dirty=true;
}

function resetCodeCaches(){
  overviewCanvas=document.createElement('canvas');overviewCanvas.width=1000*overviewScale;overviewCanvas.height=680*overviewScale;overviewContext=overviewCanvas.getContext('2d',{alpha:true});overviewIndex=0;codeTextureBytes=0;codeTextureLru.clear();
}

const spatialCell=50;
function buildSpatialGrid(){
  spatialGrid=new Map();
  for(const item of layoutItems){
    const x0=Math.floor(item.x/spatialCell),x1=Math.floor((item.x+item.w)/spatialCell),y0=Math.floor(item.y/spatialCell),y1=Math.floor((item.y+item.h)/spatialCell);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const key=`${x}:${y}`,cell=spatialGrid.get(key);if(cell)cell.push(item);else spatialGrid.set(key,[item]);}
  }
}
function visibleLayout(w,h){
  let candidates=layoutItems;
  if(renderer.mode==='2d'&&renderer.camera.zoom>1){
    const halfW=w/(2*renderer.camera.zoom),halfH=h/(2*renderer.camera.zoom),x0=Math.floor((renderer.camera.x-halfW)/spatialCell),x1=Math.floor((renderer.camera.x+halfW)/spatialCell),y0=Math.floor((renderer.camera.y-halfH)/spatialCell),y1=Math.floor((renderer.camera.y+halfH)/spatialCell),seen=new Set(),near=[];
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)for(const item of spatialGrid.get(`${x}:${y}`)||[])if(!seen.has(item.id)){seen.add(item.id);near.push(item);}
    candidates=near;
  }
  const visible=[];
  for(const item of candidates){const rect=renderer.screenRect(item);if(rect.x>w||rect.y>h||rect.x+rect.w<0||rect.y+rect.h<0)continue;visible.push({item,rect});}
  return visible;
}

function applySnapshot(snapshot){
  sourceQueue.length=0;queuedSources.clear();
  files=snapshot.files||[];for(const file of files)file.symbols||=[];edges=snapshot.edges||[];currentName=snapshot.name||'codebase';currentSnapshot=snapshot.id||null;selected=null;history=[];searchHits=[];expandedCoverageLayer=null;coverageActiveIndex=-1;cameraAnimation=null;
  fileById=new Map(files.map(file=>[file.id,file]));referenceDegree=new Map();edgesByFile=new Map();let known=0,inferred=0;for(const edge of edges){referenceDegree.set(edge.from,(referenceDegree.get(edge.from)||0)+1);referenceDegree.set(edge.to,(referenceDegree.get(edge.to)||0)+1);for(const id of [edge.from,edge.to]){const list=edgesByFile.get(id);if(list)list.push(edge);else edgesByFile.set(id,[edge]);}if(edge.confidence==='known')known++;else inferred++;}
  const layers=new Map();for(const file of files){const layer=file.layer in layerLabels?file.layer:'unknown';layers.set(layer,(layers.get(layer)||0)+1);}sceneStats={definitions:snapshot.definitions??files.reduce((n,file)=>n+(file.symbolCount||0),0),totalLines:snapshot.totalLines??files.reduce((n,file)=>n+file.lines,0),known,inferred,layers};
  computeLayout();fitScene();updateStats(snapshot);renderInspector();renderResults([]);renderHistory();
  $('#breadcrumbText').textContent=currentName;$('#emptyState').hidden=files.length>0;
}

function fitScene(){
  cameraAnimation=null;
  renderer.camera.x=500;renderer.camera.y=340;
  renderer.camera.zoom=Math.min((viewport.clientWidth-24)/1000,(viewport.clientHeight-24)/680);
  renderer.camera.distance=3.5;renderer.camera.yaw=-.12;renderer.camera.pitch=.76;dirty=true;
}

function pan3d(dx,dy){
  const {yaw,distance}=renderer.camera;
  const scale=Math.max(.18,distance*.29);
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  // Keep the grabbed ground point beneath the pointer in screen space.
  renderer.camera.x+=(-dx*cy-dy*sy)*scale;
  renderer.camera.y+=( dx*sy-dy*cy)*scale;
}

function dolly3d(amount){
  renderer.camera.distance=Math.max(MIN_3D_DISTANCE,Math.min(14,renderer.camera.distance*Math.exp(amount)));
}

function updateStats(snapshot={}){
  const definitions=snapshot.definitions??files.reduce((n,file)=>n+file.symbols.length,0);
  const references=snapshot.references??edges.length;
  $('#headlineStats').textContent=`${format(definitions)} definitions · ${format(references)} references`;
  $('#fileStats').textContent=`${format(files.length)} files · ${format(snapshot.totalLines??files.reduce((n,f)=>n+f.lines,0))} lines`;
}

function format(value){return Number(value||0).toLocaleString();}
function escapeHtml(value=''){return String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));}

const syntaxPalette={plain:'#aab5af',comment:'#64726b',string:'#89b88f',number:'#83a8d8',keyword:'#d8a75b',type:'#79b8d8',function:'#d6cf8b',property:'#b397d5',operator:'#8d9c95',constant:'#d98585',tag:'#65b9aa'};
const syntaxKeywords=new Set(`abstract as async await break case catch class const continue crate def default defer delete do else enum export extends extern false final finally fn for from func function get go if impl import in instanceof interface is lambda let loop match mod module mut namespace new nil None null of override package private protected pub public raise readonly require return self set static struct super switch this throw trait true try type typeof undefined union unsafe use using var virtual void where while with yield`.split(' '));
const syntaxConstants=new Set('true false null nil none undefined nan infinity self this super'.split(' '));
const tokenPattern=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[\da-f]+\b|\b0b[01]+\b|#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[A-Za-z_$][\w$-]*|\s+|./gi;

function syntaxKind(file={}){
  const ext=(file.extension||file.name?.split('.').pop()||'').toLowerCase(),language=(file.language||'').toLowerCase();
  if(['html','htm','xml','svg','vue','svelte'].includes(ext))return'markup';
  if(['css','scss','sass','less'].includes(ext))return'css';
  if(['json','jsonc','toml','yaml','yml'].includes(ext))return'data';
  if(['md','mdx','rst','txt'].includes(ext)||language==='docs')return'docs';
  if(['py','pyi','rb','r','pl','sh','bash','zsh','fish'].includes(ext))return'hash-comment';
  if(['sql','lua','hs'].includes(ext))return'dash-comment';
  return language==='other'?'plain':'code';
}

function commentStart(line,kind){
  const markers=kind==='markup'?['<!--']:kind==='css'?['/*']:kind==='hash-comment'?['#']:kind==='dash-comment'?['--']:kind==='data'?['//','#']:kind==='docs'?[]:['//','/*'];
  let quote='',escaped=false;
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"||char==='`'){quote=char;continue;}
    for(const marker of markers)if(line.startsWith(marker,i))return i;
  }
  return -1;
}

function syntaxTokens(line,file){
  const kind=syntaxKind(file);
  if(kind==='docs'&&/^\s{0,3}#{1,6}\s/.test(line))return[{text:line,type:'keyword'}];
  const commentAt=commentStart(line,kind),code=commentAt<0?line:line.slice(0,commentAt),tokens=[];
  tokenPattern.lastIndex=0;let match;
  while((match=tokenPattern.exec(code))){
    const text=match[0],lower=text.toLowerCase(),rest=code.slice(tokenPattern.lastIndex),before=code.slice(0,match.index),quoted=/^["'`]/.test(text);
    let type='plain';
    if(quoted)type='string';
    else if(/^(?:0x[\da-f]+|0b[01]+|#[\da-f]{3,8}|\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(text))type='number';
    else if(syntaxConstants.has(lower))type='constant';
    else if(syntaxKeywords.has(text))type='keyword';
    else if(/^[A-Za-z_$]/.test(text)){
      if(kind==='markup'&&(/<\/?\s*$/.test(before)||/^\s*>/.test(rest)))type='tag';
      else if((kind==='data'||kind==='css')&&/^\s*[:=]/.test(rest))type='property';
      else if(/^\s*\(/.test(rest))type='function';
      else if(/^[A-Z]/.test(text))type='type';
      else if(/\.\s*$/.test(before))type='property';
    }else if(!/^\s+$/.test(text))type='operator';
    tokens.push({text,type});
  }
  if(commentAt>=0)tokens.push({text:line.slice(commentAt),type:'comment'});
  return tokens;
}

function highlightSource(source,file){
  if(!source)return'<span class="tok-comment">No preview available.</span>';
  return source.split('\n').map(line=>syntaxTokens(line,file).map(token=>`<span class="tok-${token.type}">${escapeHtml(token.text)}</span>`).join('')).join('\n');
}

async function loadFileDetails(file){
  if(!file||!currentSnapshot||file.detailsLoaded||file.sourceLoading)return;
  const snapshotId=currentSnapshot;file.sourceLoading=true;
  try{
    const response=await fetch(`/api/snapshots/${snapshotId}/entities/${file.id}`);
    if(!response.ok)throw new Error('Could not load complete file');
    const payload=await response.json();if(currentSnapshot!==snapshotId)return;
    for(const record of [fileById.get(file.id),layoutById.get(file.id)])if(record){record.symbols=payload.symbols||record.symbols||[];record.symbolCount=payload.symbols?.length??record.symbolCount??0;record.detailsLoaded=true;}
  }catch(error){file.sourceError=error.message;file.source=file.preview??'';}
  finally{file.sourceLoading=false;if(selected?.id===file.id)renderInspector();dirty=true;}
}

async function loadSourceChunk(file,start,limit=600){
  if(!currentSnapshot)return[];file._sourceChunks||=new Map();file._sourceRequests||=new Map();
  if(file._sourceChunks.has(start))return file._sourceChunks.get(start);
  if(file._sourceRequests.has(start))return file._sourceRequests.get(start);
  const snapshotId=currentSnapshot,promise=fetch(`/api/snapshots/${snapshotId}/entities/${file.id}/source?start=${start}&limit=${limit}`).then(response=>{if(!response.ok)throw new Error('Could not load source lines');return response.json();}).then(payload=>{if(currentSnapshot!==snapshotId)return[];file._sourceChunks.set(start,payload.lines||[]);return payload.lines||[];}).catch(()=>[]).finally(()=>file._sourceRequests.delete(start));
  file._sourceRequests.set(start,promise);return promise;
}

const sourceQueue=[],queuedSources=new Set();let activeSourceLoads=0;
function queueFullSource(file){
  if(!file||!currentSnapshot||Object.hasOwn(file,'source')||file.sourceLoading||queuedSources.has(file.id))return;
  queuedSources.add(file.id);sourceQueue.push(file);pumpSourceQueue();
}
function pumpSourceQueue(){
  while(activeSourceLoads<4&&sourceQueue.length){
    const file=sourceQueue.shift();queuedSources.delete(file.id);activeSourceLoads++;
    loadSourceChunk(file,0,4096).then(lines=>{const source=lines.join('\n');for(const record of [fileById.get(file.id),layoutById.get(file.id)])if(record){record.source=source;record._tileSource='';record._tileLines=null;}dirty=true;}).finally(()=>{activeSourceLoads--;pumpSourceQueue();});
  }
}

function mountSourceViewer(file){
  const viewer=$('#sourceViewer'),windowElement=$('#sourceWindow'),spacer=$('#sourceSpacer');if(!viewer||!windowElement||!spacer)return;
  const lineHeight=16,total=Math.max(1,file.lines);file._sourceChunks||=new Map();
  spacer.style.height=`${Math.max(lineHeight,total*lineHeight)}px`;spacer.style.width='8000px';
  let frame=0,drawVersion=0;
  const draw=async()=>{
    frame=0;const version=++drawVersion,start=Math.max(0,Math.floor(viewer.scrollTop/lineHeight)-12),count=Math.ceil(viewer.clientHeight/lineHeight)+24,chunkStart=Math.floor(start/600)*600;
    const lines=await loadSourceChunk(file,chunkStart,600);if(version!==drawVersion||!viewer.isConnected)return;
    const offset=start-chunkStart,end=Math.min(lines.length,offset+count);windowElement.style.transform=`translateY(${start*lineHeight}px)`;
    windowElement.innerHTML=lines.slice(offset,end).map((line,index)=>`<span class="source-line" data-line="${start+index+1}">${highlightSource(line,file)||'&nbsp;'}</span>`).join('');
  };
  viewer.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(draw);},{passive:true});draw();
}

function selectFile(file,addHistory=true){
  selected=file||null;
  if(!file)coverageActiveIndex=-1;
  if(file&&addHistory){history=history.filter(item=>item.id!==file.id);history.unshift(file);history=history.slice(0,30);renderHistory();}
  $('#breadcrumbText').textContent=file?`${currentName}  ›  ${file.path}`:currentName;
  renderInspector();if(file)loadFileDetails(file);dirty=true;
}

function renderInspector(){
  const hint=$('#inspectHint'),content=$('#inspectContent');
  if(!files.length){hint.hidden=false;hint.textContent='Open a local folder or public GitHub repository to begin.';content.innerHTML='';return;}
  if(!selected){
    hint.hidden=false;hint.textContent=expandedCoverageLayer?'Click a file or use ↑ and ↓ to move around the map':'Select an entity on the map';
    const coverageRows=Object.entries(layerLabels).map(([key,label])=>`<button class="coverage-row${expandedCoverageLayer===key?' active':''}" type="button" data-coverage-layer="${key}" aria-expanded="${expandedCoverageLayer===key}"><i style="background:${palettes[paletteIndex][key]}"></i><span>${label}</span><small>${format(sceneStats.layers.get(key)||0)}</small><b aria-hidden="true">${expandedCoverageLayer===key?'−':'+'}</b></button>`).join('');
    const expandedLabel=layerLabels[expandedCoverageLayer];
    content.innerHTML=`<div class="entity-title"><small>Coverage · ${escapeHtml(currentName)}</small><h2>${format(files.length)} indexed files</h2></div><div class="meta-grid"><span>known links</span><b>${format(sceneStats.known)}</b><span>inferred links</span><b>${format(sceneStats.inferred)}</b><span>definitions</span><b>${format(sceneStats.definitions)}</b><span>source lines</span><b>${format(sceneStats.totalLines)}</b></div><div class="section-title coverage-title"><span>Semantic coverage</span><small>Click a section</small></div><div class="coverage-menu">${coverageRows}</div>${expandedCoverageLayer?`<div class="coverage-list-head"><span>${escapeHtml(expandedLabel)}</span><small>Click or ↑ ↓ to navigate</small></div><div class="coverage-file-list" id="coverageFileList" tabindex="0" role="listbox" aria-label="${escapeHtml(expandedLabel)} files"><div class="coverage-list-spacer" id="coverageListSpacer"></div><div class="coverage-list-window" id="coverageListWindow"></div></div>`:''}`;
    content.querySelectorAll('[data-coverage-layer]').forEach(row=>row.addEventListener('click',()=>toggleCoverageLayer(row.dataset.coverageLayer)));
    if(expandedCoverageLayer)mountCoverageList(expandedCoverageLayer);
    return;
  }
  hint.hidden=true;
  const related=(edgesByFile.get(selected.id)||[]).slice(0,30).map(edge=>({edge,file:fileById.get(edge.from===selected.id?edge.to:edge.from)})).filter(item=>item.file);
  const sourceStatus=selected.sourceLoading?'Loading complete file…':selected.sourceError?'Preview only':`${format(selected.lines)} lines`;
  content.innerHTML=`<div class="entity-title"><small>${escapeHtml(selected.path)}</small><h2>${escapeHtml(selected.name)}</h2></div><div class="meta-grid"><span>language</span><b>${escapeHtml(selected.language)}</b><span>semantic layer</span><b>${escapeHtml(layerLabels[selected.layer]||'Other')}</b><span>source lines</span><b>${format(selected.lines)}</b><span>definitions</span><b>${format(selected.symbols.length)}</b><span>complexity</span><b>${format(selected.complexity)}</b><span>connections</span><b>${format(related.length)}</b></div>${selected.symbols.length?`<div class="section-title">Definitions · ${selected.symbols.length}</div>${selected.symbols.slice(0,18).map(symbol=>`<div class="relation"><i style="background:var(--yellow)"></i><span>${escapeHtml(symbol.name)}</span><small>${symbol.line}</small></div>`).join('')}`:''}${related.length?`<div class="section-title">Relationships · ${related.length}</div>${related.map(({edge,file})=>`<div class="relation" data-id="${file.id}"><i></i><span>${escapeHtml(file.path)}</span><small>${edge.confidence}</small></div>`).join('')}`:''}<div class="section-title source-title"><span>Source</span><small>${sourceStatus}</small></div><div class="code-preview" id="sourceViewer" tabindex="0" aria-label="Scrollable source for ${escapeHtml(selected.name)}"><div class="source-spacer" id="sourceSpacer"></div><pre class="source-window" id="sourceWindow"></pre></div>`;
  content.querySelectorAll('.relation[data-id]').forEach(row=>row.addEventListener('click',()=>selectFile(fileById.get(Number(row.dataset.id)))));
  mountSourceViewer(selected);
}

function normalizedLayer(file){return file.layer in layerLabels?file.layer:'unknown';}

function toggleCoverageLayer(layer){
  cancelCameraAnimation();expandedCoverageLayer=expandedCoverageLayer===layer?null:layer;coverageActiveIndex=-1;renderInspector();dirty=true;
  if(expandedCoverageLayer)requestAnimationFrame(()=>$('#coverageFileList')?.focus({preventScroll:true}));
}

function mountCoverageList(layer){
  const list=$('#coverageFileList'),spacer=$('#coverageListSpacer'),windowElement=$('#coverageListWindow');if(!list||!spacer||!windowElement)return;
  const layerFiles=files.filter(file=>normalizedLayer(file)===layer).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'}));
  const rowHeight=43;spacer.style.height=`${layerFiles.length*rowHeight}px`;
  let frame=0;
  const renderWindow=()=>{
    frame=0;const start=Math.max(0,Math.floor(list.scrollTop/rowHeight)-4),count=Math.ceil(list.clientHeight/rowHeight)+8,end=Math.min(layerFiles.length,start+count);
    windowElement.style.transform=`translateY(${start*rowHeight}px)`;
    windowElement.innerHTML=layerFiles.slice(start,end).map((file,offset)=>{const index=start+offset;return`<button type="button" class="coverage-file${coverageActiveIndex===index?' active':''}" id="coverage-file-${file.id}" data-coverage-index="${index}" role="option" aria-selected="${coverageActiveIndex===index}"><i style="background:${palettes[paletteIndex][normalizedLayer(file)]}"></i><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span><em>${format(file.lines)}</em></button>`;}).join('')||'<div class="coverage-empty">No files in this section.</div>';
  };
  const preview=index=>{
    if(!layerFiles.length)return;coverageActiveIndex=Math.max(0,Math.min(layerFiles.length-1,index));const file=layerFiles[coverageActiveIndex];list.setAttribute('aria-activedescendant',`coverage-file-${file.id}`);
    const top=coverageActiveIndex*rowHeight,bottom=top+rowHeight;if(top<list.scrollTop)list.scrollTop=top;else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;
    focusFile(file);renderWindow();dirty=true;
  };
  list.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(renderWindow);},{passive:true});
  list.addEventListener('click',event=>{const row=event.target.closest('[data-coverage-index]');if(row)preview(Number(row.dataset.coverageIndex));});
  list.addEventListener('keydown',event=>{
    let next=coverageActiveIndex;
    if(event.key==='ArrowDown')next=next<0?0:next+1;
    else if(event.key==='ArrowUp')next=next<0?layerFiles.length-1:next-1;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=layerFiles.length-1;
    else if(event.key==='Enter')next=next<0?0:next;
    else return;
    event.preventDefault();preview(next);
  });
  renderWindow();
}

function renderResults(hits){
  searchHits=hits;$('#resultBadge').textContent=hits.length||'';$('#resultSummary').textContent=hits.length?`${hits.length} matching files and definitions`:'Type in the filter to search files and symbols.';
  $('#resultList').innerHTML=hits.map(hit=>`<div class="result-row" data-id="${hit.entityId??hit.id}"><i></i><span><strong>${escapeHtml(hit.name)}</strong><small>${escapeHtml(hit.path)}${hit.line?` · ${hit.line}`:''}</small></span></div>`).join('');
  $('#resultList').querySelectorAll('.result-row').forEach(row=>row.addEventListener('click',()=>{const file=fileById.get(Number(row.dataset.id));if(file){selectFile(file);focusFile(file);} }));dirty=true;
}

function renderHistory(){
  $('#historyList').innerHTML=history.map(file=>`<div class="result-row" data-id="${file.id}"><i style="background:${palettes[paletteIndex][file.layer]||palettes[paletteIndex].unknown}"></i><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span></div>`).join('')||'<div class="result-summary">Selections will appear here.</div>';
  $('#historyList').querySelectorAll('.result-row').forEach(row=>row.addEventListener('click',()=>{const file=fileById.get(Number(row.dataset.id));selectFile(file,false);focusFile(file);}));
}

function focusFile(file){
  const item=layoutById.get(file.id);if(!item)return;
  const target={x:item.x+item.w/2,y:item.y+item.h/2};
  if(renderer.mode==='2d'){const fit=Math.min(viewport.clientWidth/Math.max(.2,item.w*1.35),viewport.clientHeight/Math.max(.2,item.h*1.35),MAX_2D_ZOOM);target.zoom=Math.min(MAX_2D_ZOOM,Math.max(fit,9/codeWorldFont(item)));}
  else target.distance=2.25;
  animateCameraTo(target);
}

function animateCameraTo(target){
  const from={},to={};for(const [key,value] of Object.entries(target)){from[key]=renderer.camera[key];to[key]=value;}
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){Object.assign(renderer.camera,to);cameraAnimation=null;dirty=true;return;}
  cameraAnimation={from,to,start:performance.now(),duration:620};dirty=true;
}

function cancelCameraAnimation(){cameraAnimation=null;}

function switchTab(name){$$('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.tab===name));$$('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===`panel-${name}`));}
$$('.tab').forEach(tab=>tab.addEventListener('click',()=>switchTab(tab.dataset.tab)));

function resizeOverlay(){const dpr=Math.min(devicePixelRatio||1,2),w=Math.floor(overlay.clientWidth*dpr),h=Math.floor(overlay.clientHeight*dpr);if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}overlayCtx.setTransform(dpr,0,0,dpr,0,0);}
function drawChip(ctx,text,x,y,maxWidth,accent,occupied,force=false,align='left'){
  if(maxWidth<24)return false;
  ctx.font='600 11px -apple-system, BlinkMacSystemFont, sans-serif';
  let label=text;
  if(ctx.measureText(label).width>maxWidth-10){let low=1,high=label.length;while(low<high){const mid=Math.ceil((low+high)/2);if(ctx.measureText(`${label.slice(0,mid)}…`).width<=maxWidth-10)low=mid;else high=mid-1;}label=`${label.slice(0,low)}…`;}
  const width=Math.min(maxWidth,ctx.measureText(label).width+10);
  if(align==='center')x-=width/2;
  const box={x:x-3,y:y-2,w:width+6,h:21};
  if(!force&&occupied?.some(other=>box.x<other.x+other.w&&box.x+box.w>other.x&&box.y<other.y+other.h&&box.y+box.h>other.y))return false;
  occupied?.push(box);
  ctx.fillStyle='rgba(27,30,28,.9)';ctx.fillRect(x,y,width,17);
  if(accent){ctx.fillStyle=accent;ctx.fillRect(x,y,2,17);}
  ctx.fillStyle='rgba(237,241,238,.94)';ctx.fillText(label,x+5,y+2);
  return true;
}
function drawFileChip(ctx,item,rect,accent,occupied,force=false){
  if(renderer.mode==='2d')return drawChip(ctx,item.name,rect.x+2,rect.y+2,Math.max(28,rect.w-4),accent,occupied,force);
  const anchor=renderer.project([item.x+item.w/2,item.y+item.h/2,item.height+2]);
  const maxWidth=Math.max(46,Math.min(160,rect.w*.9));
  return drawChip(ctx,item.name,anchor.x,anchor.y-8,maxWidth,accent,occupied,force,'center');
}
function drawOverlay(){
  resizeOverlay();const ctx=overlayCtx,w=overlay.clientWidth,h=overlay.clientHeight;ctx.clearRect(0,0,w,h);ctx.save();ctx.font='600 11px -apple-system, BlinkMacSystemFont, sans-serif';ctx.textBaseline='top';
  codeTexturesPending=false;
  codeTextureDeadline=performance.now()+5;
  const hitIds=new Set(searchHits.map(hit=>hit.entityId??hit.id)),occupied=[],visible=visibleLayout(w,h);visibleScreenItems=visible;
  let labelCount=0;
  if(showCode&&renderer.mode==='2d'){
    if(renderer.camera.zoom<=2.75)drawCodeOverview(ctx);
    else for(const {item,rect} of visible)drawCodeTexture(ctx,item,rect);
  }
  if(selected&&currentMetric==='references'){
    const selectedItem=layoutById.get(selected.id);if(selectedItem){const a=renderer.screenRect(selectedItem);const ax=a.x+a.w/2,ay=a.y+a.h/2;ctx.strokeStyle='rgba(246,213,83,.6)';ctx.lineWidth=1;for(const edge of (edgesByFile.get(selected.id)||[]).slice(0,70)){const id=edge.from===selected.id?edge.to:edge.from,bItem=layoutById.get(id);if(!bItem)continue;const b=renderer.screenRect(bItem);ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(b.x+b.w/2,b.y+b.h/2);ctx.stroke();}}
  }
  if(renderer.mode==='2d'){
    const labelDepth=renderer.camera.zoom<1.15?1:renderer.camera.zoom<1.8?2:renderer.camera.zoom<3?3:4;
    for(const dir of directoryRects){
      if(dir.depth<1||dir.depth>4)continue;const rect=renderer.screenRect(dir);if(rect.w<42||rect.h<22||rect.x>w||rect.y>h||rect.x+rect.w<0||rect.y+rect.h<0)continue;
      const color=palettes[paletteIndex][dir.node.layer]||palettes[paletteIndex].unknown;
      ctx.strokeStyle=color;ctx.globalAlpha=dir.depth===1?.88:dir.depth===2?.58:.32;ctx.lineWidth=dir.depth===1?1.6:1;ctx.strokeRect(rect.x+.5,rect.y+.5,rect.w-1,rect.h-1);ctx.globalAlpha=1;
      if(dir.depth<=labelDepth&&rect.w>82&&rect.h>30&&labelCount<72&&drawChip(ctx,`${dir.node.name}/`,rect.x+3,rect.y+3,rect.w-6,color,occupied))labelCount++;
    }
  }else{
    const labelDepth=renderer.camera.distance>4.1?1:2;
    for(const dir of directoryRects){if(dir.depth<1||dir.depth>labelDepth)continue;const point=renderer.project([dir.x+dir.w/2,dir.y+dir.h/2,1]),rect=renderer.screenRect(dir);if(point.x<0||point.x>w||point.y<0||point.y>h)continue;if(labelCount<48&&drawChip(ctx,`${dir.node.name}/`,point.x,point.y-8,Math.min(150,Math.max(60,rect.w*.65)),palettes[paletteIndex][dir.node.layer],occupied,false,'center'))labelCount++;}
  }
  const showFileLabels=renderer.mode==='2d'?renderer.camera.zoom>1.05:renderer.camera.distance<4.1;
  if(showFileLabels)for(const {item,rect} of visible){
    if(rect.w>46&&rect.h>18&&codeScreenFont(item)<5.2&&labelCount<110&&drawFileChip(ctx,item,rect,null,occupied))labelCount++;
  }
  if(hitIds.size){
    ctx.fillStyle='rgba(11,13,12,.48)';ctx.fillRect(0,0,w,h);
    for(const {item,rect} of visible){if(!hitIds.has(item.id))continue;ctx.strokeStyle='#e8c74b';ctx.lineWidth=2;ctx.strokeRect(rect.x-.5,rect.y-.5,rect.w+1,rect.h+1);drawFileChip(ctx,item,rect,'#e8c74b',null,true);}
  }
  if(selected){const item=layoutById.get(selected.id);if(item){const rect=renderer.screenRect(item);ctx.strokeStyle='#fff08a';ctx.lineWidth=2.5;ctx.strokeRect(rect.x-1,rect.y-1,rect.w+2,rect.h+2);drawFileChip(ctx,item,rect,'#fff08a',null,true);}}
  ctx.restore();
}

function codeWorldFont(item){
  // Code has a stable physical scale inside each file tile. Width establishes
  // an 80-column page; height determines how many real source lines fit.
  return Math.max(.004,Math.min(item.w/80,item.h/1.34));
}
function codeScreenFont(item){return codeWorldFont(item)*renderer.camera.zoom;}
function tileSourceLines(item){
  const source=item.source??item.preview??'';
  if(item._tileSource!==source||!item._tileLines){item._tileSource=source;item._tileLines=source.split('\n');item._tileTokens=[];}
  return item._tileLines;
}
function drawSyntaxLine(ctx,line,file,x,y,maxX,alpha,tokens=syntaxTokens(line,file)){
  let screenX=x;
  for(const token of tokens){if(screenX>maxX)break;ctx.fillStyle=syntaxPalette[token.type]||syntaxPalette.plain;ctx.globalAlpha=alpha;ctx.fillText(token.text,screenX,y);screenX+=ctx.measureText(token.text).width;}
  ctx.globalAlpha=1;
}
let codeTextureDeadline=0,codeTexturesPending=false;
function paintCodeSurface(ctx,item,width,height){
  const source=tileSourceLines(item),scale=width/Math.max(.001,item.w),fontSize=Math.max(.1,codeWorldFont(item)*scale),lineHeight=fontSize*1.34,pad=Math.max(.1,fontSize*.72);
  const count=Math.min(source.length,Math.max(1,Math.floor((height-pad*2)/lineHeight)));
  ctx.textBaseline='top';ctx.font=`${fontSize}px SFMono-Regular, Consolas, monospace`;
  for(let index=0;index<count;index++){
    const tokens=item._tileTokens[index]||(item._tileTokens[index]=syntaxTokens(source[index]||'',item));
    drawSyntaxLine(ctx,source[index]||'',item,pad,pad+index*lineHeight,width-pad,.92,tokens);
  }
}
function drawCodeOverview(ctx){
  if(!overviewCanvas)resetCodeCaches();
  while(overviewIndex<layoutItems.length&&performance.now()<codeTextureDeadline){
    const item=layoutItems[overviewIndex++],x=Math.round(item.x*overviewScale),y=Math.round(item.y*overviewScale),width=Math.max(1,Math.round(item.w*overviewScale)),height=Math.max(1,Math.round(item.h*overviewScale));
    overviewContext.save();overviewContext.translate(x,y);overviewContext.beginPath();overviewContext.rect(0,0,width,height);overviewContext.clip();paintCodeSurface(overviewContext,item,width,height);overviewContext.restore();
  }
  if(overviewIndex<layoutItems.length)codeTexturesPending=true;
  const zoom=renderer.camera.zoom;
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.globalAlpha=.96;ctx.drawImage(overviewCanvas,viewport.clientWidth/2-renderer.camera.x*zoom,viewport.clientHeight/2-renderer.camera.y*zoom,1000*zoom,680*zoom);ctx.restore();
}
function rememberCodeTexture(item,texture){
  if(item._codeTexture)codeTextureBytes-=item._codeTexture.width*item._codeTexture.height*4;
  item._codeTexture=texture;codeTextureBytes+=texture.width*texture.height*4;codeTextureLru.delete(item.id);codeTextureLru.set(item.id,item);
  while(codeTextureBytes>codeTextureBudget&&codeTextureLru.size>1){const oldest=codeTextureLru.entries().next().value;if(!oldest)break;const [id,victim]=oldest;codeTextureLru.delete(id);if(victim!==item&&victim._codeTexture){codeTextureBytes-=victim._codeTexture.width*victim._codeTexture.height*4;victim._codeTexture=null;}}
}
function buildCodeTexture(item,rect){
  const source=tileSourceLines(item),sourceKey=item._tileSource;if(!source.length)return null;
  const worldFont=codeWorldFont(item),lineCapacity=Math.max(1,Math.floor((item.h-worldFont*1.44)/(worldFont*1.34)));
  if(item.lines>source.length&&lineCapacity>source.length)queueFullSource(item);
  const dpr=Math.min(devicePixelRatio||1,2),screenWidth=Math.max(1,rect.w*dpr);
  const target=Math.max(32,Math.min(2048,2**Math.ceil(Math.log2(screenWidth))));
  const cached=item._codeTexture;
  if(cached&&item._codeSource===sourceKey&&item._codeResolution>=target/1.6&&item._codeResolution<=target*2.6){codeTextureLru.delete(item.id);codeTextureLru.set(item.id,item);return cached;}
  if(performance.now()>codeTextureDeadline&&cached){codeTexturesPending=true;return cached;}
  if(performance.now()>codeTextureDeadline){codeTexturesPending=true;return null;}
  const scale=Math.max(.01,Math.min(target/Math.max(.001,item.w),2048/Math.max(.001,item.h)));
  const width=Math.max(1,Math.round(item.w*scale)),height=Math.max(1,Math.round(item.h*scale));
  const texture=document.createElement('canvas');texture.width=width;texture.height=height;
  paintCodeSurface(texture.getContext('2d',{alpha:true}),item,width,height);
  rememberCodeTexture(item,texture);item._codeSource=sourceKey;item._codeResolution=target;return texture;
}
function drawCodeTexture(ctx,item,rect){
  const texture=buildCodeTexture(item,rect);if(!texture)return;
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.globalAlpha=.96;ctx.drawImage(texture,rect.x,rect.y,rect.w,rect.h);ctx.restore();
}

function animate(now){
  if(cameraAnimation){
    const progress=Math.min(1,(now-cameraAnimation.start)/cameraAnimation.duration),eased=1-(1-progress)**4;
    for(const key of Object.keys(cameraAnimation.to))renderer.camera[key]=cameraAnimation.from[key]+(cameraAnimation.to[key]-cameraAnimation.from[key])*eased;
    if(progress>=1)cameraAnimation=null;dirty=true;
  }
  if(dirty){renderer.render();drawOverlay();dirty=codeTexturesPending;}
  const delta=now-lastFrame;lastFrame=now;if(delta<100){frameSamples.push(delta);if(frameSamples.length>45)frameSamples.shift();if(frameSamples.length&&Math.floor(now/500)!==Math.floor((now-delta)/500)){const average=frameSamples.reduce((a,b)=>a+b,0)/frameSamples.length;$('#fps').textContent=`${Math.round(1000/average)} fps · ${(average).toFixed(1)} ms`;}}
  requestAnimationFrame(animate);
}

function pickAt(x,y){
  if(renderer.mode==='2d'){const world=renderer.worldAt(x,y),cell=spatialGrid.get(`${Math.floor(world.x/spatialCell)}:${Math.floor(world.y/spatialCell)}`)||[];let match=null,area=Infinity;for(const item of cell){if(world.x>=item.x&&world.x<=item.x+item.w&&world.y>=item.y&&world.y<=item.y+item.h){const next=item.w*item.h;if(next<area){match=item;area=next;}}}return match;}
  let best=null,distance=26;for(const {item,rect} of visibleScreenItems){const dx=x-(rect.x+rect.w/2),dy=y-(rect.y+rect.h/2),next=Math.hypot(dx,dy);if(next<distance){distance=next;best=item;}}return best;
}

viewport.addEventListener('pointerdown',event=>{
  if(event.button>2)return;
  const pan=renderer.mode==='3d'&&(event.button===1||event.button===2||event.shiftKey||event.altKey||event.metaKey||event.ctrlKey);
  if(renderer.mode==='2d'&&event.button!==0)return;
  event.preventDefault();
  cancelCameraAnimation();
  pointer={down:true,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,action:pan?'pan':'orbit',id:event.pointerId};
  viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging',pan?'panning':'orbiting');
});
viewport.addEventListener('pointermove',event=>{
  const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
  if(pointer.down&&event.pointerId===pointer.id){
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;pointer.x=event.clientX;pointer.y=event.clientY;
    if(renderer.mode==='2d'){renderer.camera.x-=dx/renderer.camera.zoom;renderer.camera.y-=dy/renderer.camera.zoom;}
    else if(pointer.action==='pan')pan3d(dx,dy);
    else{renderer.camera.yaw-=dx*.007;renderer.camera.pitch=Math.max(.045,Math.min(1.525,renderer.camera.pitch+dy*.006));}
    dirty=true;$('#tooltip').hidden=true;return;
  }
  const item=pickAt(x,y),tip=$('#tooltip');if(item){tip.hidden=false;tip.style.left=`${Math.min(viewport.clientWidth-320,x+13)}px`;tip.style.top=`${Math.min(viewport.clientHeight-70,y+13)}px`;tip.innerHTML=`${escapeHtml(item.name)}<small>${escapeHtml(item.path)} · ${format(item.lines)} lines</small>`;}else tip.hidden=true;
});
function finishPointer(event){
  if(!pointer.down||event.pointerId!==pointer.id)return;
  viewport.classList.remove('dragging','panning','orbiting');
  if(event.type==='pointerup'&&event.button===0&&Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)<4){const rect=viewport.getBoundingClientRect();selectFile(pickAt(event.clientX-rect.left,event.clientY-rect.top));}
  pointer.down=false;pointer.id=null;
}
viewport.addEventListener('pointerup',finishPointer);
viewport.addEventListener('pointercancel',finishPointer);
viewport.addEventListener('pointerleave',()=>{$('#tooltip').hidden=true;});
viewport.addEventListener('contextmenu',event=>{if(renderer.mode==='3d')event.preventDefault();});
viewport.addEventListener('wheel',event=>{event.preventDefault();cancelCameraAnimation();if(renderer.mode==='3d'){dolly3d(event.deltaY*.00115);dirty=true;return;}const rect=viewport.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,before=renderer.worldAt(x,y),factor=Math.exp(-event.deltaY*.0012);renderer.camera.zoom=Math.max(.25,Math.min(MAX_2D_ZOOM,renderer.camera.zoom*factor));const after=renderer.worldAt(x,y);renderer.camera.x+=before.x-after.x;renderer.camera.y+=before.y-after.y;dirty=true;},{passive:false});
viewport.addEventListener('dblclick',event=>{const rect=viewport.getBoundingClientRect(),file=pickAt(event.clientX-rect.left,event.clientY-rect.top);if(file){selectFile(file);focusFile(file);}});

$$('[data-view]').forEach(button=>button.addEventListener('click',()=>{cancelCameraAnimation();$$('[data-view]').forEach(v=>v.classList.toggle('active',v===button));renderer.mode=button.dataset.view;if(renderer.mode==='3d')renderer.camera.zoom=1;$('#cameraHelp').hidden=renderer.mode!=='3d';dirty=true;}));
$$('[data-metric]').forEach(button=>button.addEventListener('click',()=>{$$('[data-metric]').forEach(v=>v.classList.toggle('active',v===button));currentMetric=button.dataset.metric;computeLayout();}));
$('#codeButton').classList.toggle('active',showCode);$('#codeButton').addEventListener('click',event=>{showCode=!showCode;event.currentTarget.classList.toggle('active',showCode);dirty=true;});
$('#homeButton').addEventListener('click',()=>{selectFile(null);fitScene();});
$('#mapButton').addEventListener('click',fitScene);
$('#layersButton').addEventListener('click',()=>{showLegend=!showLegend;$('#legend').classList.toggle('open',showLegend);$('#layersButton').classList.toggle('active',showLegend);});
$('#paletteButton').addEventListener('click',()=>{paletteIndex=(paletteIndex+1)%palettes.length;computeLayout();buildLegend();renderInspector();renderHistory();});
const settingsDialog=$('#settingsDialog');
$('#settingsButton').addEventListener('click',()=>{
  $('#settingsContent').innerHTML=`<div class="settings-status"><span><i></i>WebGL2 active</span><small>${renderer.mode.toUpperCase()} landscape</small></div><div class="meta-grid settings-grid"><span>display refresh</span><b>${$('#fps').textContent.split('·')[0]}</b><span>render instances</span><b>${format(layoutItems.length)}</b><span>indexed files</span><b>${format(files.length)}</b><span>pixel ratio</span><b>${renderer.dpr.toFixed(2)}×</b><span>geometry uploads</span><b>static</b><span>camera updates</span><b>GPU uniforms</b></div>`;
  if(!settingsDialog.open)settingsDialog.showModal();
});
settingsDialog.addEventListener('click',event=>{if(event.target===settingsDialog)settingsDialog.close();});

function buildLegend(){const legend=$('#legend');legend.innerHTML=Object.entries(layerLabels).map(([key,label])=>`<button type="button" data-legend-layer="${key}"><span><i style="background:${palettes[paletteIndex][key]}"></i>${label}</span><b>${format(sceneStats.layers.get(key)||0)}</b></button>`).join('');legend.querySelectorAll('[data-legend-layer]').forEach(row=>row.addEventListener('click',()=>{selectFile(null);expandedCoverageLayer=row.dataset.legendLayer;coverageActiveIndex=-1;showLegend=false;legend.classList.remove('open');$('#layersButton').classList.remove('active');switchTab('inspector');renderInspector();requestAnimationFrame(()=>$('#coverageFileList')?.focus({preventScroll:true}));}));}

let searchTimer;
$('#searchInput').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,140);});
async function runSearch(){
  const query=$('#searchInput').value.trim();if(query.length<2){renderResults([]);return;}
  let hits=[];
  if(currentSnapshot){try{const response=await fetch(`/api/snapshots/${currentSnapshot}/search?q=${encodeURIComponent(query)}&limit=180`);hits=await response.json();}catch{} }
  else{const q=query.toLowerCase();for(const file of files){if(hits.length>=180)break;if(file.path.toLowerCase().includes(q))hits.push({entityId:file.id,path:file.path,name:file.name,line:1,kind:'file'});for(const symbol of file.symbols){if(hits.length>=180)break;if(symbol.name.toLowerCase().includes(q))hits.push({entityId:file.id,path:file.path,name:symbol.name,line:symbol.line,kind:'definition'});}}}
  renderResults(hits);switchTab('results');
}
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented)return;
  if(event.key==='/'&&document.activeElement!==$('#searchInput')){event.preventDefault();$('#searchInput').focus();}
  if(event.key==='Escape'){$('#searchInput').blur();$('#tooltip').hidden=true;}
  if((event.metaKey||event.ctrlKey)&&event.key==='o'){event.preventDefault();$('#loadDialog').showModal();}
  if(renderer.mode!=='3d'||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))return;
  cancelCameraAnimation();
  const key=event.key.toLowerCase(),orbitStep=.065,panStep=22/Math.max(.8,renderer.camera.distance);
  if(key==='arrowleft')renderer.camera.yaw+=orbitStep;
  else if(key==='arrowright')renderer.camera.yaw-=orbitStep;
  else if(key==='arrowup')renderer.camera.pitch=Math.max(.045,renderer.camera.pitch-orbitStep);
  else if(key==='arrowdown')renderer.camera.pitch=Math.min(1.525,renderer.camera.pitch+orbitStep);
  else if(key==='a')pan3d(panStep,0);
  else if(key==='d')pan3d(-panStep,0);
  else if(key==='w')pan3d(0,panStep);
  else if(key==='s')pan3d(0,-panStep);
  else if(key==='+'||key==='=')dolly3d(-.12);
  else if(key==='-'||key==='_')dolly3d(.12);
  else if(key==='f')fitScene();
  else return;
  event.preventDefault();dirty=true;
});
window.addEventListener('resize',()=>{dirty=true;});

const dialog=$('#loadDialog');$('#loadButton').addEventListener('click',()=>dialog.showModal());
$('#localFolderButton').addEventListener('click',async()=>{
  dialog.close();
  if('showDirectoryPicker' in window){try{const handle=await window.showDirectoryPicker();const chosen=[];await collectHandles(handle,'',chosen);await uploadLocal(handle.name,chosen);}catch(error){if(error.name!=='AbortError')showError(error.message);}}
  else $('#folderFallback').click();
});
$('#folderFallback').addEventListener('change',async event=>{const chosen=[...event.target.files].map(file=>({file,path:file.webkitRelativePath||file.name}));const name=chosen[0]?.path.split('/')[0]||'Local folder';await uploadLocal(name,chosen);event.target.value='';});

async function collectHandles(directory,prefix,output){for await(const [name,handle] of directory.entries()){if(name==='.git'||name==='node_modules'||name==='target')continue;const path=prefix?`${prefix}/${name}`:name;if(handle.kind==='directory')await collectHandles(handle,path,output);else{const file=await handle.getFile();output.push({file,path});}}}
async function uploadLocal(name,chosen){
  if(!chosen.length)return;showProgress('Preparing local codebase',`Sending ${format(chosen.length)} files…`,0,chosen.length);
  try{
    const response=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'local',name})});const {jobId,error}=await response.json();if(error)throw new Error(error);
    let completed=0,cursor=0;const workers=Array.from({length:Math.min(4,chosen.length)},async()=>{while(cursor<chosen.length){const index=cursor++,entry=chosen[index];if(entry.file.size>8*1024*1024){completed++;continue;}const upload=await fetch(`/api/jobs/${jobId}/files?path=${encodeURIComponent(entry.path)}`,{method:'POST',body:entry.file});if(!upload.ok)throw new Error(`Could not read ${entry.path}`);completed++;showProgress('Preparing local codebase',entry.path,completed,chosen.length);}});await Promise.all(workers);await fetch(`/api/jobs/${jobId}/commit`,{method:'POST'});watchJob(jobId);
  }catch(error){showError(error.message);}
}

$('#githubButton').addEventListener('click',startGithub);$('#githubInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();startGithub();}});
async function startGithub(){const url=$('#githubInput').value.trim();$('#githubError').textContent='';if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?(?:\.git)?$/.test(url)){ $('#githubError').textContent='Enter a public GitHub owner/repository URL.';return;}dialog.close();showProgress('Cloning repository','Connecting to GitHub…',0,0);try{const response=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'github',url,name:url.split('/').filter(Boolean).pop()?.replace(/\.git$/,'')})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Could not start indexing');watchJob(payload.jobId);}catch(error){showError(error.message);}}

function watchJob(jobId){
  const events=new EventSource(`/api/jobs/${jobId}/events`);
  events.addEventListener('progress',async event=>{const job=JSON.parse(event.data);showProgress(job.phase==='ready'?'Landscape ready':'Indexing codebase',job.message,job.completed,job.total);if(job.error){events.close();showError(job.error);}if(job.snapshotId){events.close();try{const response=await fetch(`/api/snapshots/${job.snapshotId}/scene`);const snapshot=await response.json();applySnapshot(snapshot);buildLegend();setTimeout(()=>{$('#progressCard').hidden=true;},350);}catch(error){showError(error.message);}}});
  events.onerror=()=>{events.close();showError('The indexer connection closed before the landscape was ready.');};
}
function showProgress(title,message,completed,total){$('#progressCard').hidden=false;$('#progressTitle').textContent=title;$('#progressMessage').textContent=message||'';const percent=total?Math.max(3,Math.round(completed/total*100)):12;$('#progressFill').style.width=`${percent}%`;$('#progressFill').style.background='';$('#progressCount').textContent=total?`${format(completed)} / ${format(total)} · ${percent}%`:'Working…';}
function showError(message){$('#progressCard').hidden=false;$('#progressTitle').textContent='Could not build landscape';$('#progressMessage').textContent=message;$('#progressFill').style.width='100%';$('#progressFill').style.background='var(--danger)';$('#progressCount').textContent='Check the repository or folder and try again.';}

renderer.setData([]);fitScene();renderInspector();renderHistory();requestAnimationFrame(animate);
