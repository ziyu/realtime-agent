import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OBJECTS, WALLS, type WorldObject, type WorldState } from '../shared/world.ts';
const C={ivory:'#f2eedc',wall:'#e7e1cf',wood:'#b78e64',dark:'#34584d',sage:'#b1c39a',mint:'#a6c8bd',cream:'#faf7ea'};
export class HomeScene {
  private scene=new THREE.Scene();private renderer:THREE.WebGLRenderer;private camera:THREE.OrthographicCamera;private controls:OrbitControls;
  private agent=new THREE.Group();private head=new THREE.Group();private limbs:THREE.Object3D[]=[];private book=new THREE.Group();private cup=new THREE.Group();
  private meshes:THREE.Object3D[]=[];private selection:THREE.Mesh;private goal:THREE.Mesh;private label:HTMLDivElement;private labels:{el:HTMLDivElement;p:THREE.Vector3}[]=[];
  private ray=new THREE.Raycaster();private pointer=new THREE.Vector2();private state:WorldState|null=null;private lastFrame=performance.now();private raf=0;private observer:ResizeObserver;private lastPosition=new THREE.Vector3();
  private flowers:THREE.Group[]=[];private lamp:THREE.PointLight;private selectedId:string|null=null;
  constructor(private container:HTMLElement,private select:(object:WorldObject)=>void){
    const width=container.clientWidth,height=container.clientHeight;
    this.camera=new THREE.OrthographicCamera(-11,11,9,-9,.1,120);this.camera.position.set(14,18,21);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.setSize(width,height);this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.1;this.renderer.domElement.setAttribute('aria-label','Milo 的三维家园，可拖动旋转、滚轮缩放、点击家具');this.renderer.domElement.setAttribute('data-testid','world-canvas');container.append(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.dampingFactor=.07;this.controls.minZoom=.7;this.controls.maxZoom=2.5;this.controls.minPolarAngle=.3;this.controls.maxPolarAngle=1.22;this.controls.enablePan=false;this.controls.target.set(0,0,0);
    this.scene.add(new THREE.HemisphereLight('#fffcf0','#adbca0',2.4));const sun=new THREE.DirectionalLight('#fff3d8',3);sun.position.set(-7,18,9);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-12;sun.shadow.camera.right=12;sun.shadow.camera.top=12;sun.shadow.camera.bottom=-12;sun.shadow.normalBias=.025;sun.shadow.bias=-.0003;sun.shadow.radius=4;this.scene.add(sun);
    this.box(this.scene,[14,.32,11.9],[0,-.45,0],'#c7d0b2',.26);this.box(this.scene,[13.8,.16,11.7],[0,-.2,0],'#dfebc4',.2);
    for(const [x,z,color] of [[-3.45,-2.65,'#e8d9b5'],[3.4,-2.65,'#e5d0b6'],[-3.45,2.75,'#dac6b3']] as [number,number,string][]){
      this.box(this.scene,[5.65,.12,4.3],[x,-.08,z],color,.04);
      for(let i=0;i<13;i++)this.box(this.scene,[.012,.009,4.25],[x-2.7+i*.435,-.01,z],'#c4b18f',0);
      for(let i=0;i<6;i++)this.box(this.scene,[.42,.008,.016],[x-2.45+i*.88,-.007,z+(i%2?.7:-.8)],'#c4b18f',0);
    }
    this.box(this.scene,[5.5,.13,4.25],[3.4,-.05,2.7],'#c4d49a',.18);
    for(const w of WALLS)this.box(this.scene,[w.w,1.8,w.d],[w.x,.9,w.z],C.wall,.04);
    for(const w of WALLS)this.box(this.scene,[w.w,.09,w.d+.06],[w.x,1.83,w.z],C.cream,.02);
    this.window(-3.7,-4.59);this.window(3.25,-4.59);this.window(-4.15,.82);
    for(const [x,z] of [[-1.15,-4.54],[5.35,-4.54],[-1.95,.85]])this.picture(x,z);
    for(let z=-4.5;z<=4.6;z+=.64)this.box(this.scene,[.75,.045,.57],[0,.003,z],'#f7f0d7',.025);
    for(let x=-5.5;x<=6;x+=.66)this.box(this.scene,[.59,.04,.72],[x,.006,0],'#f7f0d7',.025);
    for(let x=.7;x<4.1;x+=.63)this.box(this.scene,[.53,.035,.5],[x,.01,3.05],'#f7f2db',.03);
    for(const object of OBJECTS)this.makeObject(object);
    this.tree(-6.25,-4.3,1.05);this.tree(-6.2,4.6,.9);this.tree(6.1,.15,1);this.tree(6,4.8,1.05);this.pot(-1,4.7,.4);this.pot(6,-4.6,.4);
    this.makeAgent();this.scene.add(this.agent);
    const ring=new THREE.RingGeometry(.39,.43,48);ring.rotateX(-Math.PI/2);this.selection=new THREE.Mesh(ring,new THREE.MeshBasicMaterial({color:'#d2a464',transparent:true,opacity:.9,depthWrite:false}));this.selection.visible=false;this.selection.position.y=.025;this.scene.add(this.selection);
    this.goal=new THREE.Mesh(ring.clone(),new THREE.MeshBasicMaterial({color:'#7f9f65',transparent:true,opacity:.6,depthWrite:false}));this.goal.position.y=.025;this.goal.visible=false;this.scene.add(this.goal);
    this.lamp=new THREE.PointLight('#ffd894',0,5);this.lamp.position.set(1.6,1.6,-3.8);this.scene.add(this.lamp);
    this.label=document.createElement('div');this.label.className='agent-label';this.label.innerHTML='<span></span>Milo';container.append(this.label);
    for(const [text,x,z] of [['KITCHEN',-4,-3.9],['BEDROOM',3.2,-4.1],['STUDIO',-4.4,1.1],['GARDEN',3,1.6]] as [string,number,number][]){const el=document.createElement('div');el.className='room-label';el.textContent=text;container.append(el);this.labels.push({el,p:new THREE.Vector3(x,2.3,z)})}
    let down={x:0,y:0};this.renderer.domElement.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY}});
    this.renderer.domElement.addEventListener('pointerup',e=>{if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>7)return;const hit=this.hit(e);if(hit){this.select(hit);this.setSelected(hit.id)}});
    this.renderer.domElement.addEventListener('pointermove',e=>{this.renderer.domElement.style.cursor=this.hit(e)?'pointer':'grab'});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(container);this.resize();this.animate();
    document.addEventListener('visibilitychange',()=>{this.lastFrame=performance.now()});
  }
  private material(color:string,extras:THREE.MeshStandardMaterialParameters={}){return new THREE.MeshStandardMaterial({color,roughness:.82,...extras})}
  private box(parent:THREE.Object3D,size:number[],pos:number[],color:string,r=.04){const geo=r?new RoundedBoxGeometry(size[0],size[1],size[2],2,Math.min(r,...size.map(v=>v/2))):new THREE.BoxGeometry(...size as [number,number,number]);const mesh=new THREE.Mesh(geo,this.material(color));mesh.position.set(...pos as [number,number,number]);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh}
  private ball(parent:THREE.Object3D,r:number,pos:number[],color:string,detail=1){const m=new THREE.Mesh(new THREE.IcosahedronGeometry(r,detail),this.material(color));m.position.set(...pos as [number,number,number]);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
  private cylinder(parent:THREE.Object3D,rt:number,rb:number,h:number,pos:number[],color:string){const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,16),this.material(color));m.position.set(...pos as [number,number,number]);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m}
  private window(x:number,z:number){this.box(this.scene,[1.35,.83,.08],[x,1.16,z],'#fbf9e9',.025);this.box(this.scene,[1.18,.68,.03],[x,1.16,z+.05],'#c5d9d1',.01);this.box(this.scene,[.045,.7,.04],[x,1.16,z+.075],C.cream,.005);this.box(this.scene,[1.22,.04,.04],[x,1.16,z+.075],C.cream,.005);this.box(this.scene,[1.48,.08,.2],[x,.72,z+.06],C.cream,.01)}
  private picture(x:number,z:number){this.box(this.scene,[.32,.43,.05],[x,1.18,z],'#bf9f7a',.012);this.box(this.scene,[.25,.35,.03],[x,1.18,z+.04],C.cream,.008);this.ball(this.scene,.08,[x,1.2,z+.05],'#a4bd9b');this.box(this.scene,[.02,.12,.02],[x,1.08,z+.07],C.dark,.002)}
  private legs(g:THREE.Group,w:number,d:number,h:number){for(const x of [-w/2+.1,w/2-.1])for(const z of [-d/2+.1,d/2-.1])this.box(g,[.1,h,.1],[x,h/2,z],C.wood,.015)}
  private makeObject(o:WorldObject){const g=new THREE.Group();g.position.set(o.x,0,o.z);g.userData.objectId=o.id;this.scene.add(g);
    if(o.id==='fridge'){this.box(g,[o.w,1.85,o.d],[0,.92,0],o.color,.08);this.box(g,[.9,.65,.045],[0,1.47,.46],'#bad2c4',.035);this.box(g,[.06,.28,.07],[.32,1.37,.52],C.cream,.02);this.box(g,[.06,.36,.07],[.32,.73,.52],C.cream,.02)}
    if(o.id==='stove'||o.id==='sink'){this.box(g,[o.w,.82,o.d],[0,.41,0],o.color,.035);this.box(g,[o.w+.05,.1,o.d+.04],[0,.88,0],C.cream,.025);for(const x of [-.3,.3])this.box(g,[.05,.07,.05],[x,.64,.48],C.wood,.005);
      if(o.id==='stove'){for(const x of [-.4,.35]){this.cylinder(g,.23,.23,.025,[x,.943,0],C.dark);this.cylinder(g,.15,.15,.03,[x,.96,0],'#829389')}this.cylinder(g,.2,.17,.24,[-.4,1.08,0],'#d4a57a');this.cylinder(g,.23,.23,.04,[-.4,1.22,0],C.cream);this.ball(g,.045,[-.4,1.25,0],C.wood)}
      else{this.box(g,[.68,.018,.52],[0,.94,.06],'#789187',.13);this.box(g,[.045,.38,.045],[0,1.1,-.27],C.cream,.01);this.box(g,[.045,.045,.25],[0,1.29,-.16],C.cream,.01);this.cylinder(g,.09,.075,.15,[.42,1.02,.19],C.cream)}
    }
    if(o.id==='table'){this.legs(g,o.w,o.d,.61);this.box(g,[o.w,.12,o.d],[0,.68,0],o.color,.05);this.cylinder(g,.21,.2,.022,[0,.75,0],C.cream);this.ball(g,.08,[.04,.81,.01],'#d99769');for(const x of [-.8,.8]){this.box(g,[.37,.07,.38],[x,.4,.1],C.wood,.035);this.box(g,[.1,.38,.1],[x,.19,.1],C.wood,.01)}}
    if(o.id==='bed'){this.legs(g,o.w,o.d,.28);this.box(g,[o.w,.28,o.d],[0,.39,0],C.wood,.045);this.box(g,[o.w+.08,.24,o.d],[0,.61,0],C.cream,.11);this.box(g,[o.w+.04,.15,1.48],[0,.76,.35],o.color,.055);this.box(g,[o.w+.08,.08,.14],[0,.85,-.35],'#d7e6d8',.025);this.box(g,[1.25,.19,.49],[0,.84,-.78],C.cream,.12);this.box(g,[o.w+.15,.95,.14],[0,.7,-1.19],'#92b2a5',.03)}
    if(o.id==='shower'){this.box(g,[1.1,.12,1.22],[0,.06,0],C.cream,.06);for(const x of [-.53,.53])this.box(g,[.05,1.9,.05],[x,1,-.57],C.cream,.012);const pane=this.box(g,[1.1,1.75,.045],[0,1,-.57],o.color,.01);(pane.material as THREE.MeshStandardMaterial).transparent=true;(pane.material as THREE.MeshStandardMaterial).opacity=.43;pane.castShadow=false;this.box(g,[.07,1.2,.07],[.38,1.15,-.51],C.dark,.02);this.box(g,[.3,.055,.28],[.31,1.78,-.37],C.cream,.03);this.box(g,[.5,.64,.075],[-.5,1.1,.1],C.cream,.015)}
    if(o.id==='lamp'){this.box(g,[.52,.58,.54],[0,.29,0],C.wood,.04);this.cylinder(g,.04,.04,.33,[0,.76,0],C.dark);this.cylinder(g,.18,.26,.29,[0,1.03,0],'#f7e7b8')}
    if(o.id==='desk'){this.legs(g,o.w,o.d,.68);this.box(g,[o.w,.13,o.d],[0,.75,0],o.color,.04);this.box(g,[.72,.49,.08],[0,1.11,-.07],C.dark,.025);this.box(g,[.63,.39,.015],[0,1.11,-.015],'#5d8c7b',.01);this.box(g,[.33,.03,.18],[0,.88,0],C.dark,.01);this.box(g,[.09,.16,.08],[0,.93,-.08],C.dark,.01);this.box(g,[.52,.035,.18],[0,.84,.26],'#e1e7d2',.01);this.cylinder(g,.1,.08,.15,[.64,.87,.1],C.cream)}
    if(o.id==='bookshelf'){this.box(g,[1.18,1.65,.58],[0,.83,0],o.color,.035);for(let row=0;row<3;row++){this.box(g,[1.03,.4,.06],[0,.33+row*.5,.3],'#8f825f',.01);for(let j=0;j<5;j++)this.box(g,[.11,.24+((j+row)%3)*.055,.27],[-.42+j*.2,.36+row*.5,.23],['#a9bd9b','#e9d7b3','#a7c4bc','#b9a8c4','#c59578'][(j+row)%5],.008);this.box(g,[1.14,.055,.59],[0,.13+row*.5,.02],C.wood,.01)}}
    if(o.id==='sofa'){this.box(g,[2.05,.44,.86],[0,.4,0],o.color,.12);this.box(g,[2.05,.67,.21],[0,.68,.35],o.color,.07);for(const x of [-.92,.92])this.box(g,[.23,.57,.9],[x,.57,0],o.color,.1);for(const x of [-.46,.46])this.box(g,[.75,.15,.61],[x,.66,-.08],'#cbbfda',.07);this.box(g,[.37,.35,.17],[.51,.86,.19],C.cream,.07)}
    if(o.id==='bench'){this.legs(g,1.6,.65,.47);for(const z of [-.22,0,.22])this.box(g,[1.72,.08,.17],[0,.53,z],o.color,.02);this.box(g,[1.7,.32,.1],[0,.83,-.26],o.color,.025);for(const x of [-.7,.7])this.box(g,[.07,.5,.08],[x,.7,-.27],C.wood,.008)}
    if(o.id==='planter'){this.box(g,[2.06,.41,.85],[0,.22,0],C.wood,.05);this.box(g,[1.91,.03,.7],[0,.435,0],'#81795b',.02);for(let i=0;i<9;i++){const flower=new THREE.Group();flower.position.set(-.78+(i%5)*.39,.44,-.19+Math.floor(i/5)*.35);this.cylinder(flower,.016,.016,.35,[0,.18,0],'#72976c');this.ball(flower,.08,[-.04,.23,.025],'#90b67b');const color=['#e6ba83','#d99991','#e6d293'][i%3];for(let j=0;j<5;j++)this.ball(flower,.065,[Math.cos(j*1.26)*.075,.38,Math.sin(j*1.26)*.075],color);this.ball(flower,.045,[0,.395,0],'#e9d58b');g.add(flower);this.flowers.push(flower)}}
    this.meshes.push(g);
  }
  private tree(x:number,z:number,size:number){const g=new THREE.Group();g.position.set(x,0,z);g.scale.setScalar(size);this.scene.add(g);this.cylinder(g,.085,.13,1.15,[0,.58,0],C.wood);this.ball(g,.5,[-.26,1.37,0],'#a5bd8c');this.ball(g,.57,[.18,1.51,.08],'#aac993');this.ball(g,.43,[.04,1.66,-.23],'#c3d6a6');this.cylinder(g,.28,.3,.06,[0,.03,0],'#b6c994')}
  private pot(x:number,z:number,size:number){this.cylinder(this.scene,size*.4,size*.3,size*.5,[x,size*.25,z],C.wood);this.ball(this.scene,size*.45,[x,size*.72,z],'#92b088')}
  private makeAgent(){
    this.box(this.agent,[.43,.45,.32],[0,.55,0],'#aac4a3',.075);this.box(this.agent,[.3,.3,.035],[0,.58,.18],'#dce7ca',.025);
    this.head.position.y=.99;this.agent.add(this.head);this.box(this.head,[.58,.45,.45],[0,0,0],'#c6d7b1',.1);this.box(this.head,[.43,.29,.045],[0,0,.23],C.dark,.075);
    for(const x of [-.115,.115]){const eye=this.ball(this.head,.041,[x,.025,.269],'#f0efc8',2);(eye.material as THREE.MeshStandardMaterial).emissive=new THREE.Color('#90b893');(eye.material as THREE.MeshStandardMaterial).emissiveIntensity=.4}
    this.cylinder(this.head,.025,.025,.15,[0,.28,0],'#b29c6e');this.ball(this.head,.047,[0,.37,0],'#dbbf7e');
    for(const x of [-.155,.155]){const leg=new THREE.Group();leg.position.set(x,.34,0);this.box(leg,[.135,.29,.17],[0,-.125,0],C.dark,.045);this.box(leg,[.155,.1,.24],[0,-.27,.035],'#c8d6b5',.04);this.agent.add(leg);this.limbs.push(leg)}
    for(const x of [-.3,.3]){const arm=new THREE.Group();arm.position.set(x,.72,0);this.box(arm,[.125,.31,.14],[0,-.15,0],'#b5cba8',.05);this.agent.add(arm);this.limbs.push(arm)}
    this.book.position.set(0,.62,.35);this.box(this.book,[.48,.08,.3],[0,0,0],'#b9a3bd',.02);this.box(this.book,[.43,.04,.28],[0,.05,0],C.cream,.01);this.book.visible=false;this.agent.add(this.book);
    this.cup.position.set(.23,.67,.3);this.cylinder(this.cup,.09,.07,.18,[0,0,0],C.cream);this.cup.visible=false;this.agent.add(this.cup);
  }
  private hit(e:PointerEvent){const rect=this.renderer.domElement.getBoundingClientRect();this.pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);this.ray.setFromCamera(this.pointer,this.camera);const hit=this.ray.intersectObjects(this.meshes,true)[0];if(!hit)return null;let o:THREE.Object3D|null=hit.object;while(o&&!o.userData.objectId)o=o.parent;return OBJECTS.find(x=>x.id===o?.userData.objectId)??null}
  setSelected(id:string|null){this.selectedId=id;const o=OBJECTS.find(x=>x.id===id);this.selection.visible=!!o;if(o)this.selection.position.set(o.approach.x,.026,o.approach.z)}
  update(s:WorldState){this.state=s;this.lamp.intensity=s.resources.lampOn?3:0;const a=s.agent.action;this.goal.visible=!!a;const target=a&&OBJECTS.find(o=>o.id===ACTIONS_OBJECT[a.id]);if(target)this.goal.position.set(target.approach.x,.026,target.approach.z)}
  resetCamera(){this.camera.position.set(14,18,21);this.camera.zoom=1;this.controls.target.set(0,0,0);this.camera.updateProjectionMatrix();this.controls.update()}
  zoom(delta:number){this.camera.zoom=THREE.MathUtils.clamp(this.camera.zoom+delta,.7,2.5);this.camera.updateProjectionMatrix()}
  private resize(){const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;const aspect=w/h,span=aspect<1.2?17/aspect:15.5;this.camera.left=-span*aspect/2;this.camera.right=span*aspect/2;this.camera.top=span/2;this.camera.bottom=-span/2;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h)}
  private placeLabel(el:HTMLElement,p:THREE.Vector3){const projected=p.clone().project(this.camera);el.style.left=`${(projected.x*.5+.5)*this.container.clientWidth}px`;el.style.top=`${(-projected.y*.5+.5)*this.container.clientHeight}px`;el.style.opacity=projected.z>1?'0':'1'}
  private animate=()=>{this.raf=requestAnimationFrame(this.animate);const dt=Math.min((performance.now()-this.lastFrame)/1000,.08),t=performance.now()/1000,s=this.state;this.lastFrame=performance.now();this.controls.update();
    if(s){const target=new THREE.Vector3(s.agent.position.x,0,s.agent.position.z);this.lastPosition.copy(this.agent.position);this.agent.position.lerp(target,1-Math.exp(-dt*14));const d=this.agent.position.clone().sub(this.lastPosition);const walking=s.agent.action?.phase==='walking'&&!s.paused;const acting=s.agent.action?.phase==='acting'&&!s.paused;const id=s.agent.action?.id;
      if(walking&&d.lengthSq()>.00001){const angle=Math.atan2(d.x,d.z),diff=Math.atan2(Math.sin(angle-this.agent.rotation.y),Math.cos(angle-this.agent.rotation.y));this.agent.rotation.y+=diff*Math.min(dt*10,1)}
      this.agent.position.y=walking?Math.abs(Math.sin(t*9*s.speed))*.055:Math.sin(t*2)*.012;
      this.limbs.forEach((l,i)=>l.rotation.x=walking?Math.sin(t*9*s.speed+(i%2)*Math.PI)*.48:acting&&i>1?-.55+Math.sin(t*3)*.1:0);
      this.head.rotation.z=acting&&id==='sleep'?-.2:Math.sin(t*.8)*.025;
      this.book.visible=acting&&id==='read';this.cup.visible=acting&&(id==='drink'||id==='water_plants');
      this.label.classList.toggle('thinking',s.slow.status==='thinking');this.placeLabel(this.label,this.agent.position.clone().add(new THREE.Vector3(0,1.65,0)));
      for(const f of this.flowers)f.rotation.z=Math.sin(t*1.7+f.position.x)*.055;
    }
    for(const l of this.labels)this.placeLabel(l.el,l.p);
    this.goal.scale.setScalar(1+Math.sin(t*2)*.06);this.renderer.render(this.scene,this.camera);
  };
  dispose(){cancelAnimationFrame(this.raf);this.observer.disconnect();this.controls.dispose();this.scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose()}});this.renderer.dispose()}
}
const ACTIONS_OBJECT:Record<string,string>={snack:'fridge',cook:'stove',eat:'table',drink:'sink',sleep:'bed',shower:'shower',work:'desk',read:'bookshelf',rest:'sofa',water_plants:'planter',sit:'bench',toggle_light:'lamp'};
