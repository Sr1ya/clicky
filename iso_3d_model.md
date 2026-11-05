# Isometric 3D Model Builder

The user names a topic ("a jet engine", "a human eye", "a coffee machine") and gets back a published, colorful, rotatable isometric 3D model. Speed comes from one rule: **the viewer engine below is fixed; per topic you write only the `MODEL` object** (a parts list plus geometry). Don't redesign the page or rewrite controls.

## Workflow (aim for one write, one check, one publish)

1. **Say one line about what you're building and start right away.** Don't ask questions unless the topic is truly ambiguous.
2. **Check originality.** Don't reproduce a specific branded product, vehicle, logo or character (iPhone, Tesla Roadster, Starship, Raspberry Pi, Sonic…), even when the user supplies photos of it. Offer and build an original design in the same category instead ("an original flagship phone", "an original heavy-lift rocket"). Generic subjects (a heart, a drone, a castle, a V8 engine) are fine as-is.
3. **Plan 6–10 parts** in your head: name, short label, one-sentence real description, color, and an explode offset. Use real units, scales and terms from the subject (mm, bpm, mAh, part names), and make each description a true, useful fact.
4. **Copy the template** below to the scratchpad as `<topic>.html`. Replace `{{TITLE}}` (2–4 word name, e.g. "Heart Explorer", "Phone Teardown") and `{{SUBTITLE}}`. Then rewrite only the `MODEL` object.
5. **Syntax-check:** extract the inline `<script>` and run `node --check`.
6. **Take one optional render check** with Playwright (recipe below), then fix anything obvious in one pass.
7. **Publish** with the Artifact tool (icon: one generic word such as `cube`, `heart`, `rocket`). Reply in 2–4 sentences: what it shows and which buttons do what. Don't recap the steps.

## The MODEL API

```js
const MODEL={
  title, sub, kind:'Part'|'Region'|'Layer'|'Structure', hint,
  accent:'#hex',          // badge + active-button color that suits the subject
  explodeStart:false,     // true for teardowns, so it opens exploded
  actions:[{label:'Ignite', on:false, toggle(on,K){ K.state.fire=on; }}],  // extra toggle buttons
  build(K){ ... },        // create parts
  tick(K,t,dt){ ... }     // per-frame animation; read flags you set in K.state; respect K.reduce
};
```

`K.part(name, desc, color, explode=[x,y,z], short)` returns a `THREE.Group`. Add meshes to it. Every part gets a legend chip, tap/hover inspection and dim-the-rest highlighting automatically. When Explode is on, the part moves by `explode`. The engine auto-centers the model, frames the camera to its bounding box, and adds lights, shadows and a floor. Absolute scale doesn't matter, but keep +Y up and the model resting on y≥0.

Geometry helpers all return meshes with shadows, and the `e` flag adds dark outline edges:
- `K.box(w,h,d,color,x,y,z,e=true)`
- `K.cyl(rTop,rBot,h,color,x,y,z,seg=32)`, `K.cone(r,h,color,x,y,z)`, `K.sphere(r,color,x,y,z)`, `K.torus(r,tube,color,x,y,z)` (lies flat)
- `K.tube([[x,y,z],...], radius, color)` for vessels, cables, pipes and arms (Catmull-Rom curve)
- `K.lathe([[r,y],...], color, x,y,z)` for nose cones, bottles, vases, bells and columns
- `K.slab(K.rr(w,d,radius,cx,cz), thickness, y, color)` for rounded-rectangle plates (PCBs, phones, decks). Shapes may have holes: `shape.holes.push(K.rr(...))`.
- `K.deform(fn, color, seg)` for organic forms (organs, rocks, creatures). `fn(v,i)` gets a unit-sphere point `v`, mutates it in place, and may return a 0..1 shade for baked shading. Combine it with `K.noise(x,y,z)` (Perlin, about -1..1) for folds, bumps and ridges.
- `K.mat(color, {transparent:true, opacity:.3, emissive:0x...})` for glass or glowing materials
- Raw `K.THREE` is available for anything else, such as InstancedMesh for many pins or `CanvasTexture` for screens.

Set `mesh.userData.nopick=true` on effects like exhaust plumes so taps go through them.

## Quality rules that make it look good fast

- **Color:** give each part its own saturated, distinct hue, plus neutral greys for structure. The legend doubles as the color key. For anatomy, use meaningful colors (red/blue blood, lobe colors).
- **Silhouette first:** get the 2–3 biggest masses' proportions right before adding detail, then add 10–30 small detail meshes such as ports, screws, LEDs, vents and lenses. Detail sells it.
- **Explode offsets:** for stacked layers, use increasing +Y per layer. For assemblies, push parts outward along their natural axis. Ground-level parts like legs and pads move little or down.
- **Animation (optional, one idea):** spinning wheels or props, heartbeat scale pulses, engine flicker, doors swinging. Gate it behind an `actions` toggle and skip it when `K.reduce` is set.
- **Organic subjects:** sculpt with `deform`. Stretch the sphere into the outline, flatten undersides with clamps, add fold patterns from `abs(noise)` zero-crossings, and assign regions per vertex by position. For multi-region coloring of one mesh, do it in `deform`'s return shade, or write the `color` attribute directly afterward.
- Keep everything to Three.js r128 from cdnjs (already in the template). No other libraries.

## Render check recipe (optional, once)

The workspace can't reach cdnjs. Install three locally once (`npm i three@0.128.0` in the scratchpad), then:

```python
import sys
from playwright.sync_api import sync_playwright
src=open(sys.argv[1]).read(); three=open('node_modules/three/build/three.min.js').read()
html='<!doctype html><html><head><meta charset=utf-8></head><body>'+src+'</body></html>'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=swiftshader','--enable-unsafe-swiftshader'])
    pg=b.new_page(viewport={'width':1100,'height':800})
    pg.route('**/three.min.js',lambda r:r.fulfill(body=three,content_type='application/javascript'))
    pg.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.set_content(html); pg.wait_for_timeout(3000); pg.screenshot(path=sys.argv[2])
    pg.click('#sep'); pg.wait_for_timeout(2500); pg.screenshot(path=sys.argv[3])
    print(errs); b.close()
```

If Chromium isn't found, pass `executable_path` for the installed Chrome. View the two PNGs once, make one round of fixes, and publish.

## Template (copy verbatim; edit only the title, subtitle and MODEL)

```html
<title>{{TITLE}}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: full-bleed WebGL stage, title top-left, legend + inspector + controls docked bottom */
:root{
  --bg:#12131a; --panel:rgba(25,27,37,.86); --line:#2e3142;
  --fg:#eeeef3; --muted:#9296a8; --accent:#5fd0e6; --on-accent:#111;
  --display:"Familjen Grotesk",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  color-scheme:dark;
}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font-family:var(--mono);overflow:hidden}
#stage{position:fixed;inset:0;display:block;width:100%;height:100%;touch-action:none;cursor:grab}
#stage.drag{cursor:grabbing}
.ui{position:fixed;left:0;right:0;pointer-events:none;
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.top{top:0;padding-block:calc(16px + env(safe-area-inset-top,0px)) 0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
h1{font-family:var(--display);font-weight:700;font-size:clamp(20px,3.4vw,30px);margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:12px;margin-top:4px}
.badge{font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--line);padding:5px 9px;border-radius:999px;color:var(--accent);background:var(--panel)}
.bottom{bottom:0;padding-block:0 calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px}
.legend{pointer-events:auto;display:flex;gap:6px;flex-wrap:wrap}
.chip{display:flex;align-items:center;gap:6px;font:600 11px var(--mono);padding:6px 9px;border-radius:999px}
.chip[aria-pressed="true"]{border-color:var(--fg);background:rgba(255,255,255,.08)}
.inspector{pointer-events:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;max-width:480px;backdrop-filter:blur(8px)}
.inspector .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.inspector .n{font-family:var(--display);font-size:18px;font-weight:700;margin:2px 0 4px;display:flex;align-items:center;gap:8px}
.inspector .d{font-size:12px;line-height:1.55;opacity:.88}
.sw{width:12px;height:12px;border-radius:3px;border:1px solid rgba(255,255,255,.25);flex:none}
.controls{pointer-events:auto;display:flex;gap:8px;flex-wrap:wrap}
button{font:600 12px var(--mono);color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 12px;cursor:pointer}
button:hover{border-color:var(--muted)}
.controls button[aria-pressed="true"]{color:var(--on-accent);background:var(--accent);border-color:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>

<canvas id="stage" aria-label="{{TITLE}} — rotatable 3D model"></canvas>
<div class="ui top">
  <div><h1 id="t"></h1><div class="sub" id="s"></div></div>
  <span class="badge" id="gl">WebGL</span>
</div>
<div class="ui bottom">
  <div class="legend" id="legend"></div>
  <div class="inspector" aria-live="polite">
    <div class="k" id="kind">Part</div>
    <div class="n"><span class="sw" id="sw"></span><span id="pname"></span></div>
    <div class="d" id="pdesc"></div>
  </div>
  <div class="controls" id="controls">
    <button id="sep" aria-pressed="false">Explode</button>
    <button id="spin" aria-pressed="true">Auto-rotate</button>
    <button id="reset">Reset view</button>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
/* ======================= MODEL — the only section to write per topic ======================= */
const MODEL={
  title:'{{TITLE}}', sub:'{{SUBTITLE}}', kind:'Part',
  hint:'Tap a part to learn what it does. Drag to rotate, scroll or pinch to zoom.',
  accent:'#5fd0e6',
  explodeStart:false,
  actions:[],        // {label, on, toggle(on,K)}
  build(K){
    const p=K.part('Example block','Replace build() with the topic\'s parts.',0x5fd0e6,[0,1,0]);
    p.add(K.box(2,1,2,0x5fd0e6,0,.5,0));
  },
  tick(K,t,dt){}
};
/* ============================== ENGINE — do not edit below ============================== */
(function(){
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const P=new Uint8Array(512);{const p=[...Array(256).keys()];let s=11;for(let i=255;i>0;i--){s=(s*16807)%2147483647;const j=s%(i+1);[p[i],p[j]]=[p[j],p[i]];}for(let i=0;i<512;i++)P[i]=p[i&255];}
const fade=t=>t*t*t*(t*(t*6-15)+10),lp=(a,b,t)=>a+t*(b-a);
function gr(h,x,y,z){h&=15;const u=h<8?x:y,v=h<4?y:(h===12||h===14?x:z);return((h&1)?-u:u)+((h&2)?-v:v);}
function noise(x,y,z){const X=Math.floor(x)&255,Y=Math.floor(y)&255,Z=Math.floor(z)&255;x-=Math.floor(x);y-=Math.floor(y);z-=Math.floor(z);
  const u=fade(x),v=fade(y),w=fade(z),A=P[X]+Y,AA=P[A]+Z,AB=P[A+1]+Z,B=P[X+1]+Y,BA=P[B]+Z,BB=P[B+1]+Z;
  return lp(lp(lp(gr(P[AA],x,y,z),gr(P[BA],x-1,y,z),u),lp(gr(P[AB],x,y-1,z),gr(P[BB],x-1,y-1,z),u),v),
    lp(lp(gr(P[AA+1],x,y,z-1),gr(P[BA+1],x-1,y,z-1),u),lp(gr(P[AB+1],x,y-1,z-1),gr(P[BB+1],x-1,y-1,z-1),u),v),w);}

const $=id=>document.getElementById(id);
const canvas=$('stage');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x12131a,1);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
$('gl').textContent=renderer.capabilities.isWebGL2?'WebGL2':'WebGL1 fallback';
const scene=new THREE.Scene();
const root=new THREE.Group();scene.add(root);
const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,1e5);
let S=1;
const lineMat=new THREE.LineBasicMaterial({color:0x06080b,transparent:true,opacity:.45});

const mat=(c,o={})=>c&&c.isMaterial?c:new THREE.MeshLambertMaterial(Object.assign({color:c},o));
function fin(geo,c,x=0,y=0,z=0,edges=true){const m=new THREE.Mesh(geo,mat(c,geo.attributes.color?{vertexColors:true}:{}));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;
  if(edges)m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo,30),lineMat));return m;}
const K={THREE,noise,clamp,mat,scene,root,state:null,parts:[],
  box:(w,h,d,c,x,y,z,e=true)=>fin(new THREE.BoxGeometry(w,h,d),c,x,y,z,e),
  cyl:(rt,rb,h,c,x,y,z,seg=32,e=false)=>fin(new THREE.CylinderGeometry(rt,rb,h,seg),c,x,y,z,e),
  cone:(r,h,c,x,y,z,seg=32)=>fin(new THREE.ConeGeometry(r,h,seg),c,x,y,z,false),
  sphere:(r,c,x,y,z,seg=48)=>fin(new THREE.SphereGeometry(r,seg,seg*0.75|0),c,x,y,z,false),
  torus:(r,t,c,x,y,z)=>{const m=fin(new THREE.TorusGeometry(r,t,12,64),c,x,y,z,false);m.rotation.x=Math.PI/2;return m;},
  tube:(pts,r,c,seg=64)=>fin(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p=>p.isVector3?p:new THREE.Vector3(...p))),seg,r,16,false),c,0,0,0,false),
  lathe:(prof,c,x=0,y=0,z=0,seg=48)=>fin(new THREE.LatheGeometry(prof.map(([r,h])=>new THREE.Vector2(Math.max(r,.0001),h)),seg),c,x,y,z,false),
  rr(w,h,r,x=0,z=0){const s=new THREE.Shape(),X=x-w/2,Y=-z-h/2;s.moveTo(X+r,Y);s.lineTo(X+w-r,Y);s.quadraticCurveTo(X+w,Y,X+w,Y+r);s.lineTo(X+w,Y+h-r);
    s.quadraticCurveTo(X+w,Y+h,X+w-r,Y+h);s.lineTo(X+r,Y+h);s.quadraticCurveTo(X,Y+h,X,Y+h-r);s.lineTo(X,Y+r);s.quadraticCurveTo(X,Y,X+r,Y);return s;},
  slab(shape,t,y,c,e=true){const g=new THREE.ExtrudeGeometry(shape,{depth:t,bevelEnabled:false,curveSegments:14});g.rotateX(-Math.PI/2);g.translate(0,y,0);return fin(g,c,0,0,0,e);},
  deform(fn,c,seg=160){const g=new THREE.SphereGeometry(1,seg,seg*0.75|0),p=g.attributes.position,n=p.count,v=new THREE.Vector3(),col=new Float32Array(n*3),base=new THREE.Color(c);
    for(let i=0;i<n;i++){v.fromBufferAttribute(p,i);const s=fn(v,i);p.setXYZ(i,v.x,v.y,v.z);const k=s===undefined?1:s;col[i*3]=base.r*k;col[i*3+1]=base.g*k;col[i*3+2]=base.b*k;}
    g.computeVertexNormals();g.setAttribute('color',new THREE.BufferAttribute(col,3));return fin(g,0xffffff,0,0,0,false);},
  part(name,desc,color,explode=[0,0,0],short){const g=new THREE.Group();g.userData={name,desc,color,explode:new THREE.Vector3(...explode),short:short||name,idx:K.parts.length};
    root.add(g);K.parts.push(g);return g;}
};
const state={sel:-1,hover:-1,sep:MODEL.explodeStart?1:0,sepT:MODEL.explodeStart?1:0,spin:true,rotY:-0.6,vel:0,zoom:1};K.state=state;
MODEL.build(K);
const bb=new THREE.Box3().setFromObject(root),ctr=bb.getCenter(new THREE.Vector3());
root.position.set(-ctr.x,-bb.min.y+0.001,-ctr.z);
const holder=new THREE.Group();scene.add(holder);holder.add(root);
const mid=(bb.max.y-bb.min.y)/2;
const sz=bb.getSize(new THREE.Vector3());S=Math.max(sz.y*0.62,Math.hypot(sz.x,sz.z)*0.42,0.01);
scene.add(new THREE.HemisphereLight(0xeef2ff,0x1d1f28,0.6));
const key=new THREE.DirectionalLight(0xffffff,0.8);key.position.set(-S*2,S*6,S*3);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
Object.assign(key.shadow.camera,{left:-S*3,right:S*3,top:S*3,bottom:-S*3,near:.01,far:S*20});key.shadow.bias=-0.0005;scene.add(key);
const rim=new THREE.DirectionalLight(0xa9c8ff,0.3);rim.position.set(S*4,S,-S*4);scene.add(rim);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(S*60,S*60),new THREE.ShadowMaterial({opacity:.3}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
K.parts.forEach(g=>g.userData.home=g.position.clone());

document.documentElement.style.setProperty('--accent',MODEL.accent||'#5fd0e6');document.title=MODEL.title;$('t').textContent=MODEL.title;$('s').textContent=MODEL.sub;$('kind').textContent=MODEL.kind;
const chips=[];
K.parts.forEach((g,i)=>{const b=document.createElement('button');b.className='chip';b.setAttribute('aria-pressed','false');
  b.innerHTML='<span class="sw" style="background:#'+g.userData.color.toString(16).padStart(6,'0')+'"></span>';b.append(g.userData.short);
  b.onclick=()=>select(state.sel===i?-1:i);$('legend').appendChild(b);chips.push(b);});
MODEL.actions.forEach(a=>{const b=document.createElement('button');b.textContent=a.label;b.setAttribute('aria-pressed',!!a.on);
  b.onclick=()=>{a.on=!a.on;b.setAttribute('aria-pressed',a.on);a.toggle&&a.toggle(a.on,K);};$('controls').insertBefore(b,$('spin'));});
function info(i){if(i<0){$('pname').textContent='Tap a '+MODEL.kind.toLowerCase();$('pdesc').textContent=MODEL.hint;$('sw').style.background='transparent';return;}
  const u=K.parts[i].userData;$('pname').textContent=u.name;$('pdesc').textContent=u.desc;$('sw').style.background='#'+u.color.toString(16).padStart(6,'0');}
function dim(g,on){g.traverse(o=>{if(!o.material||o.isLineSegments)return;const m=o.material;if(m.userData.b===undefined){m.userData.b=m.opacity;m.userData.t=m.transparent;}
  m.opacity=on?Math.min(m.userData.b,.15):m.userData.b;m.transparent=on||m.userData.t;m.depthWrite=!on&&m.userData.b>=1;m.needsUpdate=true;
  if(m.emissive)m.emissive.setHex(0);});}
function highlight(){const a=state.sel>=0?state.sel:state.hover;K.parts.forEach((g,i)=>{dim(g,a>=0&&i!==a);if(i===a)g.traverse(o=>o.material&&o.material.emissive&&o.material.emissive.setHex(0x1c1c22));});}
function select(i){state.sel=i;chips.forEach((c,k)=>c.setAttribute('aria-pressed',k===i));info(i);highlight();}
info(-1);

function resize(){const w=innerWidth,h=innerHeight,a=w/h,d=(a<1?S/Math.max(a,.55)*.7:S)*1.15;
  Object.assign(camera,{left:-d*a,right:d*a,top:d,bottom:-d});camera.updateProjectionMatrix();renderer.setSize(w,h,false);}
addEventListener('resize',resize);resize();
$('sep').setAttribute('aria-pressed',!!state.sepT);
$('sep').onclick=()=>{state.sepT=state.sepT?0:1;$('sep').setAttribute('aria-pressed',!!state.sepT);};
$('spin').onclick=()=>{state.spin=!state.spin;$('spin').setAttribute('aria-pressed',state.spin);};
$('reset').onclick=()=>{state.rotY=-0.6;state.vel=0;state.zoom=1;select(-1);};

const ray=new THREE.Raycaster(),ptr=new THREE.Vector2();
function pick(cx,cy){ptr.set(cx/innerWidth*2-1,-(cy/innerHeight)*2+1);ray.setFromCamera(ptr,camera);
  for(const h of ray.intersectObjects(K.parts,true)){if(!h.object.isMesh||h.object.userData.nopick)continue;
    if(h.object.material.opacity<.3&&state.sel>=0)continue;let o=h.object;while(o&&o.userData.idx===undefined)o=o.parent;if(o)return o.userData.idx;}return -1;}
let down=null,lastX=0,moved=0,lastH=-2;const touches=new Map();let pinch0=0,zoom0=1;
canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);touches.set(e.pointerId,e);
  if(touches.size===2){const [a,b]=[...touches.values()];pinch0=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);zoom0=state.zoom;}
  down=e;lastX=e.clientX;moved=0;state.vel=0;canvas.classList.add('drag');});
canvas.addEventListener('pointermove',e=>{if(touches.has(e.pointerId))touches.set(e.pointerId,e);
  if(touches.size===2){const [a,b]=[...touches.values()];state.zoom=clamp(zoom0*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch0,.5,5);moved=99;return;}
  if(down){const dx=e.clientX-lastX;lastX=e.clientX;moved+=Math.abs(dx);state.rotY+=dx*.008;state.vel=dx*.008;}
  else if(e.pointerType==='mouse'&&state.sel<0){const h=pick(e.clientX,e.clientY);if(h!==lastH){lastH=h;state.hover=h;info(h);highlight();}}});
function up(e){touches.delete(e.pointerId);canvas.classList.remove('drag');if(down&&moved<5){const h=pick(e.clientX,e.clientY);select(h===state.sel?-1:h);}down=null;}
canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
canvas.addEventListener('wheel',e=>{e.preventDefault();state.zoom=clamp(state.zoom*Math.exp(-e.deltaY*.0015),.5,5);},{passive:false});
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;K.reduce=reduce;
if(reduce){state.spin=false;$('spin').setAttribute('aria-pressed','false');}

const tgt=new THREE.Vector3();let t=0,last=performance.now();
function loop(now){requestAnimationFrame(loop);const dt=Math.min(.05,(now-last)/1000||0);last=now;t+=dt;
  if(!down){if(state.spin)state.rotY+=.003;state.rotY+=state.vel;state.vel*=.93;}
  holder.rotation.y=state.rotY;
  state.sep+=(state.sepT-state.sep)*(reduce?1:.07);
  K.parts.forEach(g=>g.position.copy(g.userData.home).addScaledVector(g.userData.explode,state.sep));
  MODEL.tick&&MODEL.tick(K,t,dt);
  tgt.set(0,mid*(1+0.35*state.sep)-S*0.38,0);camera.position.copy(tgt).add(new THREE.Vector3(S*20,S*20,S*20));camera.lookAt(tgt);
  camera.zoom=state.zoom/(1+0.3*state.sep);camera.updateProjectionMatrix();
  renderer.render(scene,camera);}
requestAnimationFrame(loop);
})();
</script>
```

## Worked example (tested): quadcopter drone `MODEL`

```js
const MODEL={
  title:'Quadcopter Drone', sub:'Camera drone · 4 rotors · iso view', kind:'Part',
  hint:'Tap a part to learn what it does. Drag to rotate, scroll or pinch to zoom.',
  accent:'#ff7a33', explodeStart:false,
  actions:[{label:'Props',on:true,toggle(on,K){K.state.props=on;}}],
  build(K){
    const body=K.part('Body shell','Moulded shell that houses the flight controller and battery.',0xe6e8ec,[0,1.2,0],'Body');
    body.add(K.slab(K.rr(2.4,3.2,.8),.7,.6,0xe6e8ec));
    const bat=K.part('Battery','4S lithium-polymer pack, about 30 minutes of flight.',0x3a6df0,[0,2.6,-2.5],'Battery');
    bat.add(K.box(1.4,.5,2,0x3a6df0,0,1.55,0));
    const arms=K.part('Arms','Carbon-fibre arms that fold for transport.',0x30333a,[0,.4,0]);
    K.rotors=[];
    [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([x,z])=>{const m=K.box(3.4,.18,.3,0x30333a,x*1.2,.9,z*1.2);m.rotation.y=-Math.atan2(z,x);arms.add(m);});
    const mot=K.part('Motors','Brushless motors spinning up to 10,000 rpm.',0xff7a33,[0,1.6,0]);
    const prop=K.part('Propellers','Diagonal pairs spin opposite ways to cancel torque.',0x5fd0e6,[0,2.8,0],'Props');
    [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([x,z])=>{mot.add(K.cyl(.28,.28,.4,0xff7a33,x*2.3,1.15,z*2.3));
      const r=new K.THREE.Group();r.position.set(x*2.3,1.42,z*2.3);r.add(K.box(2.2,.04,.22,0x5fd0e6,0,0,0,false));prop.add(r);K.rotors.push([r,x*z]);});
  },
  tick(K,t,dt){if(K.state.props!==false&&!K.reduce)K.rotors.forEach(([r,d])=>r.rotation.y+=d*dt*25);}
};
```

## When the user gives an image

If the user attaches a reference image of something original (their own product, sketch or object), read the image and match its silhouette and proportions in `build()`: trace 15–25 outline points into a `lathe` profile, a `slab` shape or a `deform` radius table. If the img2threejs skill is installed and the user asks for it, use that pipeline instead. The originality rule above applies either way: photos of a branded product don't make copying it acceptable.
