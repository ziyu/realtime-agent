import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ACTIONS, WALLS } from '../shared/world';
import type { ActionId, ActionSpec, WorldState } from '../shared/types';

export function createHome(container: HTMLElement, onSelect: (id: ActionId) => void, onError: (message: string) => void) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9ede6');
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 120);
  camera.position.set(16, 18, 20);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.domElement.setAttribute('aria-label', 'Milo 的 3D 家园，可拖动旋转、滚轮缩放、点击家具');
  renderer.domElement.setAttribute('role', 'img');
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0); controls.enableDamping = true; controls.enablePan = false;
  controls.minZoom = 0.7; controls.maxZoom = 2.4;
  controls.minPolarAngle = 0.25; controls.maxPolarAngle = Math.PI / 2.7; controls.update();
  scene.add(new THREE.HemisphereLight('#fff8e9', '#9dab95', 2.3));
  const sun = new THREE.DirectionalLight('#fff6df', 3.8);
  sun.position.set(-6, 16, 8); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
  sun.shadow.normalBias = 0.045; sun.shadow.bias = -0.0002; scene.add(sun);

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (color: string) => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    return materials.get(color)!;
  };
  const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) => {
    const item = new THREE.Mesh(geometry, mat(color)); item.position.set(x, y, z);
    item.castShadow = true; item.receiveShadow = true; parent.add(item); return item;
  };
  const box = (p: THREE.Object3D, w: number, h: number, d: number, color: string, x: number, y: number, z: number, round = false) => mesh(p, round ? new RoundedBoxGeometry(w, h, d, 2, Math.min(0.08, h / 4, w / 4, d / 4)) : new THREE.BoxGeometry(w, h, d), color, x, y, z);
  const sphere = (p: THREE.Object3D, r: number, color: string, x: number, y: number, z: number) => mesh(p, new THREE.SphereGeometry(r, 16, 12), color, x, y, z);
  const cylinder = (p: THREE.Object3D, top: number, bottom: number, h: number, color: string, x: number, y: number, z: number) => mesh(p, new THREE.CylinderGeometry(top, bottom, h, 20), color, x, y, z);
  function plant(p: THREE.Object3D, x: number, z: number, scale = 1, y = 0.15) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(scale); p.add(g);
    cylinder(g, 0.28, 0.21, 0.4, '#bd9276', 0, 0.2, 0);
    cylinder(g, 0.24, 0.24, 0.025, '#655546', 0, 0.407, 0);
    cylinder(g, 0.025, 0.03, 0.75, '#69834d', 0, 0.72, 0);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const leaf = sphere(g, 0.24, i % 2 ? '#789865' : '#4c7350', Math.cos(angle) * 0.16, 0.65 + i * 0.075, Math.sin(angle) * 0.16);
      leaf.scale.set(0.5, 1.5, 0.85); leaf.rotation.z = Math.cos(angle) * 0.7;
    }
  }

  box(scene, 100, 0.1, 100, '#e9ede6', 0, -0.85, 0).castShadow = false;
  box(scene, 13.2, 0.62, 10.2, '#b6bba7', 0, -0.48, 0, true);
  box(scene, 12.75, 0.28, 9.75, '#f9f7ed', 0, -0.05, 0, true);
  for (const [x, z, color] of [[-3, 2.25, '#e6dac3'], [3, 2.25, '#dce0d6'], [-3, -2.25, '#e6d4bd'], [3, -2.25, '#e5ddcb']] as const) {
    box(scene, 5.97, 0.08, 4.47, color, x, 0.12, z).castShadow = false;
    for (let i = 0; i < 7; i++) box(scene, 5.95, 0.003, 0.015, '#cfbea5', x, 0.163, z - 1.9 + i * 0.58).castShadow = false;
  }
  box(scene, 12.25, 1.9, 0.18, '#f5f1e5', 0, 1.08, -4.55);
  box(scene, 0.18, 1.6, 9.2, '#f5f1e5', -6.05, 0.93, 0);
  for (const wall of WALLS) box(scene, wall.width, 0.55, wall.depth, '#faf7ed', wall.x, 0.425, wall.z);
  box(scene, 12.3, 0.075, 0.23, '#ffffff', 0, 2.06, -4.55);
  box(scene, 0.23, 0.075, 9.2, '#ffffff', -6.05, 1.76, 0);
  for (const x of [-3.1, 2.8]) {
    box(scene, 2.15, 1.08, 0.06, '#b6c9c4', x, 1.33, -4.435);
    box(scene, 2.32, 0.09, 0.24, '#ffffff', x, 0.77, -4.35);
    for (const dx of [-1.08, 0, 1.08]) box(scene, 0.055, 1.1, 0.085, '#ffffff', x + dx, 1.33, -4.37);
    box(scene, 2.2, 0.055, 0.08, '#ffffff', x, 1.32, -4.37);
  }

  const interactive: THREE.Group[] = [];
  function furniture(a: ActionSpec) {
    const g = new THREE.Group(); g.position.set(a.position.x, 0, a.position.z);
    g.userData.action = a.id; scene.add(g); interactive.push(g);
    const w = a.size.x, d = a.size.z;
    if (a.id === 'relax') {
      box(g, w, 0.45, d, '#6c8772', 0, 0.5, 0, true);
      box(g, 0.25, 0.9, d, '#5d7865', -0.49, 0.75, 0, true);
      for (const z of [-1.2, 1.2]) box(g, w, 0.7, 0.22, '#5d7865', 0, 0.64, z, true);
      for (const z of [-0.7, 0, 0.7]) box(g, 0.88, 0.18, 0.64, '#90a18a', 0.14, 0.79, z, true);
      box(g, 0.25, 0.46, 0.48, '#efe2c1', -0.05, 1.04, -0.7, true).rotation.z = -0.3;
    } else if (a.id === 'sleep') {
      box(g, w, 0.35, d, '#ae8965', 0, 0.38, 0, true);
      box(g, w - 0.08, 0.28, d - 0.1, '#faf6ea', 0, 0.67, 0, true);
      box(g, w - 0.06, 0.2, 1.55, '#c99573', 0, 0.86, 0.4, true);
      box(g, w + 0.04, 0.85, 0.13, '#b49878', 0, 0.69, -1.24, true);
      for (const x of [-0.44, 0.43]) box(g, 0.7, 0.18, 0.47, '#fff8eb', x, 0.91, -0.8, true);
    } else if (a.id === 'eat' || a.id === 'drink' || a.id === 'wash') {
      box(g, w, 0.82, d, '#c4c9b9', 0, 0.56, 0, true);
      box(g, w + 0.1, 0.1, d + 0.1, '#fff9eb', 0, 1.02, 0, true);
      if (a.id === 'eat') {
        box(g, 0.82, 0.025, 0.92, '#444d48', 0, 1.09, 0.05, true);
        for (const z of [-0.2, 0.32]) cylinder(g, 0.2, 0.2, 0.02, '#929c91', 0, 1.11, z);
        cylinder(g, 0.19, 0.15, 0.18, '#ba7556', 0, 1.2, -0.2);
      } else if (a.id === 'drink') {
        cylinder(g, 0.17, 0.24, 0.43, '#90b9b7', 0.05, 1.29, 0.05);
        cylinder(g, 0.08, 0.07, 0.16, '#fffef3', -0.3, 1.15, -0.25);
      } else {
        box(g, 0.85, 0.02, 0.56, '#a1b1ad', 0, 1.08, 0, true);
        box(g, 0.63, 0.015, 0.4, '#cadad2', 0, 1.095, 0, true);
        cylinder(g, 0.035, 0.035, 0.4, '#8a9892', 0, 1.24, 0.35);
        box(g, 0.06, 0.06, 0.27, '#8a9892', 0, 1.44, 0.24);
      }
    } else if (a.id === 'work') {
      box(g, w, 0.12, d, '#b99973', 0, 0.98, 0, true);
      for (const x of [-0.77, 0.77]) for (const z of [-0.34, 0.34]) box(g, 0.07, 0.8, 0.07, '#857f6b', x, 0.53, z);
      box(g, 0.65, 0.04, 0.45, '#d8ded7', 0, 1.075, 0.1, true);
      box(g, 0.65, 0.44, 0.04, '#455953', 0, 1.28, -0.1, true).rotation.x = -0.12;
      box(g, 0.55, 0.33, 0.02, '#88aea3', 0, 1.29, -0.072);
      for (let i = 0; i < 3; i++) box(g, 0.2 + i % 2 * 0.1, 0.02, 0.005, '#d8e4ce', -0.08, 1.37 - i * 0.08, -0.052);
      plant(g, 0.65, -0.15, 0.35, 1.055);
    } else if (a.id === 'read') {
      box(g, w, 1.55, 0.2, '#a68a69', 0, 0.92, -0.44);
      for (const x of [-0.57, 0.57]) box(g, 0.06, 1.55, d, '#b49877', x, 0.92, 0);
      for (const y of [0.25, 0.85, 1.5]) {
        box(g, w, 0.065, d, '#b49877', 0, y, 0);
        for (let i = 0; i < 5; i++) box(g, 0.13, 0.3 + i % 2 * 0.11, 0.38, ['#829582', '#c68663', '#d6c49c', '#6f8f93', '#b5a092'][i], -0.43 + i * 0.2, y + 0.2, 0.25);
      }
    } else plant(g, 0, 0, 1.05);
  }
  Object.values(ACTIONS).forEach(furniture);
  box(scene, 2.8, 0.012, 2.9, '#c9c4ad', -3.4, 0.18, 2.3, true).castShadow = false;
  box(scene, 1.3, 0.12, 0.7, '#b18e68', -2.6, 0.64, 3.6, true);
  for (const x of [-3.06, -2.16]) for (const z of [3.38, 3.82]) cylinder(scene, 0.04, 0.04, 0.47, '#806649', x, 0.4, z);
  box(scene, 0.38, 0.04, 0.27, '#c77956', -2.85, 0.725, 3.57);
  cylinder(scene, 0.1, 0.08, 0.16, '#f8f2e5', -2.36, 0.78, 3.57);
  plant(scene, -5.2, 5.75, 1.6, -0.75); plant(scene, 5.8, -5.9, 1.8, -0.75); plant(scene, -6.9, -4.1, 1.3, -0.75);
  for (let i = 0; i < 3; i++) box(scene, 1.3, 0.08, 0.5, '#d0d1bf', 1.2, -0.76, 5.5 + i * 0.74, true);

  const avatar = new THREE.Group(); scene.add(avatar);
  const torso = new THREE.Group(); avatar.add(torso);
  box(torso, 0.48, 0.52, 0.35, '#749280', 0, 0.8, 0, true);
  box(torso, 0.52, 0.45, 0.43, '#f7f5ea', 0, 1.3, 0, true);
  box(torso, 0.4, 0.2, 0.025, '#344f48', 0, 1.31, 0.22, true);
  for (const x of [-0.11, 0.11]) sphere(torso, 0.04, '#dcf2b4', x, 1.32, 0.25);
  cylinder(torso, 0.025, 0.025, 0.17, '#69806c', 0, 1.59, 0); sphere(torso, 0.055, '#dfb166', 0, 1.7, 0);
  const arms = [-1, 1].map(side => {
    const arm = new THREE.Group(); arm.position.set(side * 0.33, 0.97, 0); torso.add(arm);
    box(arm, 0.14, 0.36, 0.16, '#f1eee2', 0, -0.17, 0, true); return arm;
  });
  const legs = [-1, 1].map(side => {
    const leg = new THREE.Group(); leg.position.set(side * 0.15, 0.55, 0); avatar.add(leg);
    box(leg, 0.18, 0.31, 0.22, '#d9ded1', 0, -0.13, 0, true);
    box(leg, 0.19, 0.13, 0.29, '#6b806e', 0, -0.29, 0.04, true); return leg;
  });
  const ringMaterial = new THREE.MeshBasicMaterial({ color: '#78966b', transparent: true, opacity: 0.7 });
  const avatarRing = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.025, 8, 48), ringMaterial);
  avatarRing.rotation.x = Math.PI / 2; avatarRing.position.y = 0.18; avatar.add(avatarRing);
  const targetRing = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.035, 8, 48), ringMaterial);
  targetRing.rotation.x = Math.PI / 2; targetRing.visible = false; scene.add(targetRing);
  const pathMaterial = new THREE.LineDashedMaterial({ color: '#789670', dashSize: 0.14, gapSize: 0.11, transparent: true, opacity: 0.8 });
  const pathLine = new THREE.Line(new THREE.BufferGeometry(), pathMaterial); scene.add(pathLine);
  const labels: { element: HTMLDivElement; position: THREE.Vector3 }[] = [];
  for (const [title, subtitle, x, z] of [['客厅', 'LIVING ROOM', -3.3, 2.15], ['厨房', 'KITCHEN', 2.7, 1.45], ['卧室', 'BEDROOM', -2.7, -2.6], ['书房', 'STUDY', 2.8, -2.65]] as const) {
    const element = document.createElement('div'); element.className = 'room-label';
    const span = document.createElement('span'); span.textContent = title;
    const small = document.createElement('small'); small.textContent = subtitle;
    element.append(span, small); container.appendChild(element);
    labels.push({ element, position: new THREE.Vector3(x, 0.18, z) });
  }
  const agentLabel = document.createElement('div'); agentLabel.className = 'agent-label'; agentLabel.textContent = 'Milo'; container.appendChild(agentLabel);
  let width = 1, height = 1;
  const resize = () => {
    const bounds = container.getBoundingClientRect(); width = bounds.width; height = bounds.height;
    if (!width || !height) return;
    const aspect = width / height, size = aspect < 1.2 ? 10.5 : 7.1;
    camera.left = -size * aspect; camera.right = size * aspect; camera.top = size; camera.bottom = -size;
    camera.updateProjectionMatrix(); renderer.setSize(width, height);
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const raycaster = new THREE.Raycaster(); let pointerStart = { x: 0, y: 0 };
  const pointerDown = (e: PointerEvent) => { pointerStart = { x: e.clientX, y: e.clientY }; };
  const pointerUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 6) return;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
    let object: THREE.Object3D | null = raycaster.intersectObjects(interactive, true)[0]?.object ?? null;
    while (object && !object.userData.action) object = object.parent;
    if (object?.userData.action) onSelect(object.userData.action as ActionId);
  };
  let contextLost = false;
  const lost = (e: Event) => { e.preventDefault(); contextLost = true; onError('3D 画面连接中断，请刷新页面恢复。世界状态仍保留在服务端。'); };
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('webglcontextlost', lost);

  let world: WorldState | null = null, initializedEpoch = '', frame = 0, previousTime = performance.now(), disposed = false;
  const desired = new THREE.Vector3(), difference = new THREE.Vector3(), projected = new THREE.Vector3();
  const place = (element: HTMLElement, position: THREE.Vector3) => {
    projected.copy(position).project(camera);
    element.style.transform = `translate(${(projected.x + 1) / 2 * width}px,${(-projected.y + 1) / 2 * height}px) translate(-50%,-50%)`;
  };
  const animate = (time: number) => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    const dt = Math.min(0.1, (time - previousTime) / 1000); previousTime = time;
    if (document.hidden || contextLost) return;
    controls.update();
    if (world) {
      desired.set(world.agent.position.x, 0, world.agent.position.z);
      const moving = !world.paused && world.agent.action?.phase === 'walking';
      difference.copy(desired).sub(avatar.position);
      if (moving && difference.length() > 0.015) {
        const angle = Math.atan2(difference.x, difference.z);
        avatar.rotation.y += Math.atan2(Math.sin(angle - avatar.rotation.y), Math.cos(angle - avatar.rotation.y)) * Math.min(1, dt * 12);
      }
      avatar.position.lerp(desired, 1 - Math.exp(-dt * 14));
      const wave = moving ? Math.sin(time / 105 * world.speed) * 0.55 : 0;
      legs[0].rotation.x = wave; legs[1].rotation.x = -wave; arms[0].rotation.x = -wave; arms[1].rotation.x = wave;
      torso.position.y = world.paused ? 0 : Math.sin(time / (moving ? 105 : 550)) * (moving ? 0.035 : 0.018);
      if (!world.paused && world.agent.action?.phase === 'acting') {
        const id = world.agent.action.id;
        arms[1].rotation.x = ['water', 'drink', 'wash'].includes(id) ? -0.8 + Math.sin(time / 220) * 0.25 : -0.2;
        if (id === 'sleep' || id === 'relax') torso.position.y -= 0.12;
      }
      place(agentLabel, desired.copy(avatar.position).add(new THREE.Vector3(0, 2, 0)));
    }
    for (const item of labels) place(item.element, item.position);
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(animate);
  return {
    update(state: WorldState, selected: ActionId | null) {
      world = state;
      if (initializedEpoch !== state.epoch) { avatar.position.set(state.agent.position.x, 0, state.agent.position.z); initializedEpoch = state.epoch; }
      const id = selected ?? state.agent.action?.id; targetRing.visible = !!id;
      if (id) targetRing.position.set(ACTIONS[id].destination.x, 0.18, ACTIONS[id].destination.z);
      pathLine.geometry.dispose();
      pathLine.geometry = new THREE.BufferGeometry().setFromPoints([state.agent.position, ...(state.agent.action?.path ?? [])].map(p => new THREE.Vector3(p.x, 0.2, p.z)));
      pathLine.computeLineDistances();
      agentLabel.textContent = state.thinking ? 'Milo · 思考中' : state.paused ? 'Milo · 已暂停' : 'Milo';
    },
    resetCamera() { camera.position.set(16, 18, 20); camera.zoom = 1; controls.target.set(0, 0, 0); camera.updateProjectionMatrix(); controls.update(); },
    zoom(delta: number) { camera.zoom = THREE.MathUtils.clamp(camera.zoom + delta, 0.7, 2.4); camera.updateProjectionMatrix(); },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) object.geometry.dispose(); });
      materials.forEach(m => m.dispose()); ringMaterial.dispose(); pathMaterial.dispose();
      sun.shadow.map?.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      agentLabel.remove(); labels.forEach(item => item.element.remove());
    },
  };
}
