import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

// 部署基路径（GitHub Pages 子路径下用 './'，本地开发是 '/'）
const base = import.meta.env.BASE_URL

// ========== 共享渲染器 ==========
const app = document.getElementById('app')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
app.appendChild(renderer.domElement)

// 共享模式状态
const state = { mode: 'real' }

// ========== 现实版场景（当前样式，天空加了一点蓝） ==========
function setupReal() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 300)
  camera.position.set(0, 12, 35); camera.lookAt(0, -1, -20)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.15, 0.12, 0.12)
  bloom.threshold = 0.85; bloom.strength = 0.08; bloom.radius = 0.1
  composer.addPass(bloom)

  const target = new THREE.Vector3(0, -1, -20)

  // ========== 光照 ==========
  const sun = new THREE.DirectionalLight(0xffffff, 0.9)
  sun.position.set(100, 40, -60); sun.castShadow = true
  sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.near=0.5; sun.shadow.camera.far=200
  sun.shadow.camera.left=-80; sun.shadow.camera.right=80; sun.shadow.camera.top=80; sun.shadow.camera.bottom=-80
  scene.add(sun)
  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a8, 0.25))

  // ========== 天空（真实感大气渐变 + 太阳光晕，单次着色器绘制） ==========
  const skyGeo = new THREE.SphereGeometry(200, 64, 32)
  const skySunDir = new THREE.Vector3(0, 20, -140).normalize()
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x1e5aa8) },   // 天顶深蓝
      uMid:    { value: new THREE.Color(0x7fb2e0) },   // 中段浅蓝
      uHorizon:{ value: new THREE.Color(0xd4e3f2) },   // 地平线浅蓝白（自然）
      uSunDir: { value: skySunDir },
      uOff:    { value: 26.0 },
    },
    vertexShader: `
      varying vec3 vW;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith, uMid, uHorizon, uSunDir;
      uniform float uOff;
      varying vec3 vW;
      void main(){
        vec3 w = normalize(vW + vec3(0.0, uOff, 0.0));
        float h = clamp(w.y, 0.0, 1.0);
        // 大气散射式三段渐变：地平线暖白 -> 中段浅蓝 -> 天顶深蓝
        float t = pow(h, 0.6);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.4, t));
        col = mix(col, uZenith, smoothstep(0.4, 1.0, t));
        // 地平线附近淡淡的暖色大气光晕
        col += uHorizon * pow(1.0 - h, 3.0) * 0.18;
        // 太阳：小亮核 + 柔和内晕 + 外晕
        float sun = max(dot(w, uSunDir), 0.0);
        float disc = smoothstep(0.9992, 0.9995, sun);
        col += vec3(1.0, 0.97, 0.90) * disc * 1.5;
        col += vec3(1.0, 0.86, 0.62) * pow(sun, 12.0) * 0.35;
        col += vec3(1.0, 0.75, 0.50) * pow(sun, 4.0)  * 0.16;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  skyMesh.frustumCulled = false
  scene.add(skyMesh)

  // ========== 雪地（程序化生成：亮白雪堆起伏 + 微闪 + 法线） ==========
  function makeSnowGround() {
    const size = 512
    const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n) }
    const smooth = t => t * t * (3 - 2 * t)
    function valueNoise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y)
      const xf = x - xi, yf = y - yi
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
      const u = smooth(xf), v = smooth(yf)
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }
    function fbm(x, y) {
      let v = 0, amp = 0.5, fx = x, fy = y
      for (let i = 0; i < 6; i++) { v += amp * valueNoise(fx, fy); fx *= 2.05; fy *= 2.05; amp *= 0.52 }
      return v
    }
    const height = new Float32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const drift = fbm(x / size * 4, y / size * 4)
        const grain = fbm(x / size * 22 + 37.0, y / size * 22 + 11.0)
        height[y * size + x] = drift * 0.65 + grain * 0.35
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(size, size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x, h = height[i]
        const shade = 0.82 + h * 0.18
        let r = 255 * shade, g = 255 * shade, b = 255 * shade
        const blue = (1 - h) * 10
        r -= blue * 0.6; g -= blue * 0.38; b += blue
        const sp = hash(x * 7.13, y * 3.71)
        if (sp > 0.996) r = g = b = 255
        else if (sp > 0.99) r = g = b = 245
        img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)

    const nCanvas = document.createElement('canvas')
    nCanvas.width = nCanvas.height = size
    const nCtx = nCanvas.getContext('2d')
    const nImg = nCtx.createImageData(size, size)
    const s = 3.0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        const l = height[y * size + ((x - 1 + size) % size)]
        const r = height[y * size + ((x + 1) % size)]
        const t = height[((y - 1 + size) % size) * size + x]
        const b = height[((y + 1) % size) * size + x]
        const nx = (l - r) * s, ny = (t - b) * s, nz = 1
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
        nImg.data[i * 4] = (nx * inv * 0.5 + 0.5) * 255
        nImg.data[i * 4 + 1] = (ny * inv * 0.5 + 0.5) * 255
        nImg.data[i * 4 + 2] = (nz * inv * 0.5 + 0.5) * 255
        nImg.data[i * 4 + 3] = 255
      }
    }
    nCtx.putImageData(nImg, 0, 0)
    return { color: canvas, normal: nCanvas }
  }

  const snowMaps = makeSnowGround()

  const snowTex = new THREE.CanvasTexture(snowMaps.color)
  snowTex.colorSpace = THREE.SRGBColorSpace
  snowTex.wrapS = snowTex.wrapT = THREE.RepeatWrapping
  snowTex.repeat.set(18, 18)
  snowTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  const snowNormal = new THREE.CanvasTexture(snowMaps.normal)
  snowNormal.wrapS = snowNormal.wrapT = THREE.RepeatWrapping
  snowNormal.repeat.set(18, 18)

  const snowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ map: snowTex, color: 0xffffff, roughness: 0.75, metalness: 0 })
  )
  snowGround.rotation.x = -Math.PI / 2; snowGround.position.y = -2.9; snowGround.receiveShadow = true
  scene.add(snowGround)

  // 雪人站立位置（树会避开这里）
  const SNOWMAN_SPOTS = [
    { x: -15, z: -20 },
    { x: 15, z: -20 },
  ]

  // ========== 櫻花樹 ==========
  const treeGroup = []  // 记录树，供点击交互
  function loadTrees() {
    const loader = new GLTFLoader()
    for(let i=0;i<25;i++){
      let a, d, x, z
      do {
        a=Math.random()*Math.PI*2; d=5+Math.random()*35
        x=Math.cos(a)*d; z=Math.sin(a)*d
      } while (SNOWMAN_SPOTS.some(s => (x-s.x)**2 + (z-s.z)**2 < 9*9))
      loader.load(base + 'models/laying_under_a_tree_with_pink_leaves_and_wind/scene.gltf', gltf=>{
        const m=gltf.scene; m.position.set(x,-3,z); m.scale.setScalar(0.5+Math.random()*2)
        m.rotation.y=Math.random()*Math.PI*2
        m.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true}})
        scene.add(m); treeGroup.push(m)
        if(gltf.animations&&gltf.animations.length){const mx=new THREE.AnimationMixer(m);const ta=mx.clipAction(gltf.animations[0]);ta.play();if(!window.treeMixers)window.treeMixers=[];window.treeMixers.push(mx);if(!window.treeActions)window.treeActions=[];window.treeActions.push(ta)}
      })
    }
  }

  // ========== 草地 ==========
  function loadGrass() {
    new GLTFLoader().load(base + 'models/animated_grass_-_vegetation/scene.gltf', gltf=>{
      const orig=gltf.scene; let n=0
      for(let i=0;i<800;i++){
        if(Math.random()>0.55)continue
        const g=orig.clone()
        const sxz=0.15+Math.random()*0.6, sy=0.5+Math.random()*1.5
        g.scale.set(sxz,sy,sxz)
        g.rotation.set((Math.random()-.5)*.5,Math.random()*Math.PI*2,(Math.random()-.5)*.5)
        g.position.set((Math.random()-.5)*140, -2.2+Math.abs(sy*.3), (Math.random()-.5)*140)
        g.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true}})
        scene.add(g); n++
        if(gltf.animations&&gltf.animations.length&&n<=150){const mx=new THREE.AnimationMixer(g);mx.clipAction(gltf.animations[0]).play();if(!window.grassMixers)window.grassMixers=[];window.grassMixers.push(mx)}
      }
    })
  }

  // ========== 微風 ==========
  let wind = 0
  const windDir = new THREE.Vector3(1, 0.15, 0.3).normalize()
  function gust(){ wind = 2.5 }

  // ========== 雪花（单个 Points 对象，替代 600 个独立 Mesh，避免卡顿） ==========
  let snowTarget = 0
  let weatherOn = false
  let snowTime = 0
  const SNOW_MAX = 2000
  const snowGeo = new THREE.BufferGeometry()
  const snowPos = new Float32Array(SNOW_MAX * 3)
  const snowSpd = new Float32Array(SNOW_MAX)
  for (let i = 0; i < SNOW_MAX; i++) {
    snowPos[i*3]   = (Math.random() - 0.5) * 140
    snowPos[i*3+1] = Math.random() * 45
    snowPos[i*3+2] = (Math.random() - 0.5) * 140
    snowSpd[i] = 0.04 + Math.random() * 0.08
  }
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3))

  const snowCanvas = document.createElement('canvas')
  snowCanvas.width = snowCanvas.height = 32
  const sctx = snowCanvas.getContext('2d')
  const sg = sctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  sg.addColorStop(0, 'rgba(255,255,255,1)')
  sg.addColorStop(0.4, 'rgba(255,255,255,0.85)')
  sg.addColorStop(1, 'rgba(255,255,255,0)')
  sctx.fillStyle = sg
  sctx.fillRect(0, 0, 32, 32)

  const snowPoints = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.4, map: new THREE.CanvasTexture(snowCanvas),
    transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true
  }))
  snowPoints.frustumCulled = false
  scene.add(snowPoints)

  function updateSnow(dt){
    snowTime += dt
    for (let i = 0; i < SNOW_MAX; i++) {
      snowPos[i*3+1] -= snowSpd[i]
      snowPos[i*3]   += Math.sin(snowTime * 0.6 + i * 0.8) * 0.003 + wind * 0.06 * windDir.x
      snowPos[i*3+2] += Math.cos(snowTime * 0.5 + i * 0.6) * 0.003 + wind * 0.06 * windDir.z
      if (snowPos[i*3+1] < -5) {
        snowPos[i*3+1] = 30 + Math.random() * 15
        snowPos[i*3] = (Math.random() - 0.5) * 140
        snowPos[i*3+2] = (Math.random() - 0.5) * 140
      }
    }
    snowGeo.attributes.position.needsUpdate = true
    snowGeo.setDrawRange(0, snowTarget)
  }

  // ========== 雪人 ==========
  let snowman, snowmen=[]
  const raycaster=new THREE.Raycaster(), mouse=new THREE.Vector2()
  function createSnowmen(){
    // 白色雪材质
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 })

    function build(){
      const g = new THREE.Group()

      // 三层雪球（由下到上，底部贴地）
      const R1 = 1.3, R2 = 0.95, R3 = 0.66
      const y1 = R1
      const y2 = y1 + R1 + R2 - 0.5
      const y3 = y2 + R2 + R3 - 0.42

      const bottom = new THREE.Mesh(new THREE.SphereGeometry(R1, 32, 24), mat); bottom.position.y = y1; bottom.castShadow = bottom.receiveShadow = true; g.add(bottom)
      const middle = new THREE.Mesh(new THREE.SphereGeometry(R2, 32, 24), mat); middle.position.y = y2; middle.castShadow = middle.receiveShadow = true; g.add(middle)
      const head = new THREE.Mesh(new THREE.SphereGeometry(R3, 32, 24), mat); head.position.y = y3; head.castShadow = head.receiveShadow = true; g.add(head)

      // 胡萝卜鼻子
      const nose = new THREE.Mesh(new THREE.ConeGeometry(.09, .55, 8), new THREE.MeshStandardMaterial({ color: 0xff7722, roughness: .4 }))
      nose.position.set(0, y3 + .04, R3 * .9 + .12); nose.rotation.x = Math.PI/2; nose.castShadow = true; g.add(nose)

      // 眼睛
      const eyeGeo = new THREE.SphereGeometry(.07, 8, 8), eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: .6 })
      const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-.16, y3 + .2, R3 * .82); g.add(eyeL)
      const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(.16, y3 + .2, R3 * .82); g.add(eyeR)

      // 纽扣（中球上三颗）
      const btnGeo = new THREE.SphereGeometry(.06, 8, 8), btnMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: .6 })
      for(let i = 0; i < 3; i++){
        const bt = new THREE.Mesh(btnGeo, btnMat)
        bt.position.set(0, y2 + .3 - i * .28, R2 * .88); g.add(bt)
      }

      // 黑色礼帽
      const hatMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: .5 })
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(.55, .55, .09, 24), hatMat); brim.position.y = y3 + R3 - .08; brim.castShadow = true; g.add(brim)
      const tophat = new THREE.Mesh(new THREE.CylinderGeometry(.4, .42, .55, 24), hatMat); tophat.position.y = y3 + R3 + .22; tophat.castShadow = true; g.add(tophat)

      // 树枝手臂（中球两侧）
      const armMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: .8 })
      const armL = new THREE.Mesh(new THREE.CylinderGeometry(.05, .03, 1.3, 6), armMat); armL.position.set(-(R2 + .35), y2, 0); armL.rotation.z = .9; armL.rotation.y = -.4; armL.castShadow = true; g.add(armL)
      const armR = new THREE.Mesh(new THREE.CylinderGeometry(.05, .03, 1.3, 6), armMat); armR.position.set(R2 + .35, y2, 0); armR.rotation.z = -.9; armR.rotation.y = .4; armR.castShadow = true; g.add(armR)

      // 红色围巾（脖子处）
      const scarf = new THREE.Mesh(new THREE.TorusGeometry(.5, .1, 8, 16), new THREE.MeshStandardMaterial({ color: 0xdd3333, roughness: .5 }))
      scarf.position.y = y3 - .3; scarf.rotation.x = Math.PI/2; g.add(scarf)

      // 头顶光点
      const dot = new THREE.Mesh(new THREE.SphereGeometry(.1, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: .6, transparent: true }))
      dot.position.y = y3 + R3 + .6; dot.name = 'hint'; g.add(dot)

      return g
    }

    // 一大一小，靠近前方、面向外侧、避开树
    const big = build(); big.position.set(-15, -2.9, -20); big.scale.setScalar(2.0); big.rotation.y = -Math.PI/2; big.userData = { base: 2.0, target: 2.0 }; scene.add(big)
    const small = build(); small.position.set(15, -2.9, -20); small.scale.setScalar(0.85); small.rotation.y = Math.PI/2; small.userData = { base: 0.85, target: 0.85 }; scene.add(small)
    snowman = big; snowmen = [big, small]
  }

  // 點擊交互（现实版）：雪人切换降雪 / 空地吹风
  renderer.domElement.addEventListener('pointerdown', e=>{
    if (state.mode !== 'real') return
    mouse.x=(e.clientX/innerWidth)*2-1; mouse.y=-(e.clientY/innerHeight)*2+1
    raycaster.setFromCamera(mouse,camera)
    for(const sm of snowmen){
      if(raycaster.intersectObject(sm,true).length>0){
        e.stopImmediatePropagation()
        toggleWeather()
        return
      }
    }
    gust()
  })
  renderer.domElement.addEventListener('pointermove', e=>{
    if (state.mode !== 'real'){ renderer.domElement.style.cursor='grab'; return }
    mouse.x=(e.clientX/innerWidth)*2-1; mouse.y=-(e.clientY/innerHeight)*2+1
    raycaster.setFromCamera(mouse,camera)
    let hit=false
    for(const sm of snowmen){if(raycaster.intersectObject(sm,true).length>0){hit=true;break}}
    renderer.domElement.style.cursor=hit?'pointer':'grab'
  })

  // ========== 雲層 ==========
  const cloudList=[]
  const cMat=new THREE.MeshStandardMaterial({color:0xf0e8e0,transparent:true,opacity:.5,roughness:1})
  const cdMat=new THREE.MeshStandardMaterial({color:0xe0d0c0,transparent:true,opacity:.3,roughness:1})
  function createClouds(){
    for(let i=0;i<12;i++){
      const g=new THREE.Group()
      for(let j=0;j<6+Math.floor(Math.random()*8);j++){
        const c=new THREE.Mesh(new THREE.BoxGeometry(1+Math.random()*2,.6+Math.random()*1,1+Math.random()*2),Math.random()>.6?cdMat:cMat)
        c.position.set((Math.random()-.5)*5,(Math.random()-.5)*2,(Math.random()-.5)*5)
        g.add(c)
      }
      g.position.set((Math.random()-.5)*160,20+Math.random()*30,-70-Math.random()*60)
      g.userData={bx:g.position.x,sp:.001+Math.random()*.003,rn:4+Math.random()*8}
      scene.add(g); cloudList.push(g)
    }
  }
  function updateClouds(t){cloudList.forEach(c=>{c.position.x=c.userData.bx+Math.sin(t*.015*c.userData.sp)*c.userData.rn})}

  // ========== 初始化 ==========
  loadTrees(); loadGrass(); createSnowmen(); createClouds()

  function update(dt, frame){
    updateSnow(dt); updateClouds(frame)
    if(weatherOn){ wind = 2.5 } else { wind = Math.max(0, wind - dt*0.6) }
    if(window.treeMixers)window.treeMixers.forEach(m=>m.update(dt))
    if(window.grassMixers)window.grassMixers.forEach(m=>m.update(dt))
    // 树随风摆动：没风时完全静止，风越大摆得越明显
    if(window.treeActions){const tw=Math.min(wind,1);window.treeActions.forEach(a=>a.setEffectiveWeight(a.getEffectiveWeight()+(tw-a.getEffectiveWeight())*0.1))}
    // 整棵树轻微摆动（微动）
    treeGroup.forEach((t, i) => {
      const s = wind * 0.04
      t.rotation.z = Math.sin(frame * 0.03 + i * 1.3) * s
      t.rotation.x = Math.cos(frame * 0.02 + i * 0.9) * s * 0.5
    })

    // 雪人彈跳動畫
    for(let i=0;i<snowmen.length;i++){
      const sm=snowmen[i], b=sm.userData.base, t=sm.userData.target, c=sm.scale.x
      sm.scale.setScalar(c+(t-c)*.2)
      if(Math.abs(t-c)<.001&&t!==b)sm.userData.target=b
      const dot=sm.getObjectByName('hint')
      if(dot){dot.material.opacity=.4+Math.sin(frame*.04)*.3;dot.scale.setScalar(1+Math.sin(frame*.035)*.2)}
    }
  }
  function render(){ composer.render() }
  function resize(){ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); composer.setSize(innerWidth, innerHeight) }

  // 交互按钮对应的操作
  function toggleWeather(){
    weatherOn = !weatherOn
    if(weatherOn){
      snowTarget = 900
      wind = 2.5
    } else {
      snowTarget = 0
      wind = 0
    }
    snowmen.forEach(s=>s.userData.target=s.userData.base*(weatherOn?1.06:1))
  }

  return { camera, target, update, render, resize, toggleWeather, gust }
}

// ========== 卡通版场景 ==========
function setupCartoon() {
  const scene = new THREE.Scene()

  // 粉紫黄昏天空
  scene.background = new THREE.Color(0x6a4a8c)
  scene.fog = new THREE.FogExp2(0xffb58a, 0.008)

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000)
  camera.position.set(12, 6, 18)

  const target = new THREE.Vector3(0, 1.5, 0)

  // 灯光：粉紫黄昏氛围
  const sunLight = new THREE.DirectionalLight(0xffc49a, 1.2)
  sunLight.position.set(-8, 10, 6)
  scene.add(sunLight)

  // 白色方向光（太阳在左后方）：给 GLB 树正确的颜色和立体阴影
  const treeLight = new THREE.DirectionalLight(0xffffff, 1.3)
  treeLight.position.set(-8, 12, -8)
  treeLight.castShadow = true
  treeLight.shadow.mapSize.set(2048, 2048)
  treeLight.shadow.camera.near = 1
  treeLight.shadow.camera.far = 60
  treeLight.shadow.camera.left = -20
  treeLight.shadow.camera.right = 20
  treeLight.shadow.camera.top = 20
  treeLight.shadow.camera.bottom = -20
  treeLight.shadow.bias = -0.0005
  scene.add(treeLight)

  const backLight = new THREE.DirectionalLight(0xb888cc, 0.6)
  backLight.position.set(6, 4, -8)
  scene.add(backLight)

  const fillLight = new THREE.DirectionalLight(0xc8e0ff, 0.4)
  fillLight.position.set(0, 8, 10)
  scene.add(fillLight)

  const ambientLight = new THREE.AmbientLight(0x5a3a70, 0.45)
  scene.add(ambientLight)

  const reflectLight = new THREE.PointLight(0xa8c8ff, 0.35, 30)
  reflectLight.position.set(0, 5, 0)
  scene.add(reflectLight)

  // ========== 自然地平线橙红渐变光晕 ==========
  const glowCanvas = document.createElement('canvas')
  glowCanvas.width = 1024
  glowCanvas.height = 512
  const gCtx = glowCanvas.getContext('2d')

  const centerX = 512
  const centerY = 350
  const gradientRadius = 400

  const grad1 = gCtx.createRadialGradient(centerX, centerY, 0, centerX, centerY, gradientRadius)
  grad1.addColorStop(0, 'rgba(255, 180, 80, 0.4)')
  grad1.addColorStop(0.1, 'rgba(255, 150, 60, 0.35)')
  grad1.addColorStop(0.3, 'rgba(255, 120, 50, 0.25)')
  grad1.addColorStop(0.5, 'rgba(255, 100, 40, 0.15)')
  grad1.addColorStop(0.7, 'rgba(255, 80, 30, 0.08)')
  grad1.addColorStop(1, 'rgba(255, 60, 20, 0)')
  gCtx.fillStyle = grad1
  gCtx.fillRect(0, 0, 1024, 512)

  const grad2 = gCtx.createRadialGradient(centerX, centerY + 50, 0, centerX, centerY + 50, 500)
  grad2.addColorStop(0, 'rgba(255, 200, 100, 0.15)')
  grad2.addColorStop(0.4, 'rgba(255, 160, 80, 0.1)')
  grad2.addColorStop(0.7, 'rgba(255, 120, 60, 0.05)')
  grad2.addColorStop(1, 'rgba(255, 80, 40, 0)')
  gCtx.fillStyle = grad2
  gCtx.fillRect(0, 0, 1024, 512)

  const grad3 = gCtx.createLinearGradient(0, 350, 0, 512)
  grad3.addColorStop(0, 'rgba(255, 180, 80, 0)')
  grad3.addColorStop(0.2, 'rgba(255, 150, 70, 0.12)')
  grad3.addColorStop(0.5, 'rgba(255, 120, 50, 0.08)')
  grad3.addColorStop(0.8, 'rgba(255, 100, 40, 0.04)')
  grad3.addColorStop(1, 'rgba(255, 80, 30, 0)')
  gCtx.fillStyle = grad3
  gCtx.fillRect(0, 0, 1024, 512)

  for (let i = 0; i < 50; i++) {
    const x = 200 + Math.random() * 624
    const y = 200 + Math.random() * 200
    const radius = 30 + Math.random() * 150
    const spotGrad = gCtx.createRadialGradient(x, y, 0, x, y, radius)
    const alpha = 0.02 + Math.random() * 0.06
    spotGrad.addColorStop(0, `rgba(255, 200, 100, ${alpha})`)
    spotGrad.addColorStop(1, 'rgba(255, 200, 100, 0)')
    gCtx.fillStyle = spotGrad
    gCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }

  const glowTexture = new THREE.CanvasTexture(glowCanvas)

  const glowSphereGeo = new THREE.SphereGeometry(45, 48, 48)
  const glowSphereMat = new THREE.MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    opacity: 0.9,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const glowSphereMesh = new THREE.Mesh(glowSphereGeo, glowSphereMat)
  glowSphereMesh.position.set(0, -8, -20)
  glowSphereMesh.scale.set(1.2, 0.6, 0.8)
  scene.add(glowSphereMesh)

  // 太阳光柱效果
  const rayCanvas = document.createElement('canvas')
  rayCanvas.width = 256
  rayCanvas.height = 256
  const rCtx = rayCanvas.getContext('2d')

  const rayGrad = rCtx.createLinearGradient(128, 0, 128, 256)
  rayGrad.addColorStop(0, 'rgba(255, 200, 100, 0.15)')
  rayGrad.addColorStop(0.3, 'rgba(255, 180, 80, 0.08)')
  rayGrad.addColorStop(0.6, 'rgba(255, 150, 60, 0.03)')
  rayGrad.addColorStop(1, 'rgba(255, 120, 40, 0)')
  rCtx.fillStyle = rayGrad
  rCtx.fillRect(0, 0, 256, 256)

  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.2
    const x = 128 + Math.cos(angle) * 40
    const y = 128 + Math.sin(angle) * 20
    rCtx.beginPath()
    rCtx.moveTo(128, 128)
    rCtx.lineTo(x + Math.cos(angle) * 100, y + Math.sin(angle) * 80)
    rCtx.strokeStyle = `rgba(255, 200, 100, ${0.02 + Math.random() * 0.03})`
    rCtx.lineWidth = 8 + Math.random() * 20
    rCtx.stroke()
  }

  const rayTexture = new THREE.CanvasTexture(rayCanvas)

  const rayPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 30),
    new THREE.MeshBasicMaterial({
      map: rayTexture,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  )
  rayPlane.position.set(0, -2, -15)
  rayPlane.rotation.x = -0.1
  scene.add(rayPlane)

  // ========== 卡通白云 ==========
  const cartoonClouds = []
  const cartoonCloudGeo = new THREE.SphereGeometry(1, 12, 8)
  const cartoonCloudLight = new THREE.MeshToonMaterial({ color: 0xffffff, transparent: true, opacity: 0.88 })
  const cartoonCloudShade = new THREE.MeshToonMaterial({ color: 0xd9effa, transparent: true, opacity: 0.72 })
  function createCartoonClouds() {
    for (let i = 0; i < 10; i++) {
      const cloud = new THREE.Group()
      const puffs = 4 + Math.floor(Math.random() * 4)
      for (let j = 0; j < puffs; j++) {
        const puff = new THREE.Mesh(cartoonCloudGeo, j === 0 ? cartoonCloudShade : cartoonCloudLight)
        const size = 0.8 + Math.random() * 1.25
        puff.scale.set(size * (1.25 + Math.random() * 0.65), size * (0.45 + Math.random() * 0.35), size * (0.7 + Math.random() * 0.45))
        puff.position.set((j - puffs * 0.5) * 1.25 + (Math.random() - 0.5) * 0.6, Math.random() * 0.7, (Math.random() - 0.5) * 1.2)
        cloud.add(puff)
      }
      cloud.position.set((Math.random() - 0.5) * 34, 7 + Math.random() * 6, -12 - Math.random() * 15)
      cloud.scale.setScalar(0.9 + Math.random() * 0.8)
      cloud.userData = { baseX: cloud.position.x, baseY: cloud.position.y, speed: 0.08 + Math.random() * 0.08, phase: Math.random() * Math.PI * 2 }
      scene.add(cloud)
      cartoonClouds.push(cloud)
    }
  }
  createCartoonClouds()

  // ========== 夜晚星空 ==========
  const cartoonStarCount = 260
  const cartoonStarPositions = new Float32Array(cartoonStarCount * 3)
  for (let i = 0; i < cartoonStarCount; i++) {
    cartoonStarPositions[i * 3] = (Math.random() - 0.5) * 70
    cartoonStarPositions[i * 3 + 1] = 5 + Math.random() * 28
    cartoonStarPositions[i * 3 + 2] = -18 - Math.random() * 35
  }
  const cartoonStarGeometry = new THREE.BufferGeometry()
  cartoonStarGeometry.setAttribute('position', new THREE.BufferAttribute(cartoonStarPositions, 3))
  const cartoonStars = new THREE.Points(cartoonStarGeometry, new THREE.PointsMaterial({ color: 0xfff4d0, size: 0.22, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true }))
  cartoonStars.frustumCulled = false
  scene.add(cartoonStars)

  // ========== 清透冰面 ==========
  const iceGeometry = new THREE.PlaneGeometry(24, 24)
  const iceMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x99ccee,
    emissive: 0x221133,
    emissiveIntensity: 0.08,
    roughness: 0.01,
    metalness: 0.3,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    clearcoat: 0.5,
    clearcoatRoughness: 0.05,
    ior: 1.33,
    reflectivity: 0.9
  })

  const ice = new THREE.Mesh(iceGeometry, iceMaterial)
  ice.rotation.x = -Math.PI / 2
  ice.position.y = -0.05
  ice.receiveShadow = true
  scene.add(ice)

  const underIceGeometry = new THREE.PlaneGeometry(23.5, 23.5)
  const underIceMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x6699cc,
    roughness: 0.1,
    metalness: 0.0,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide
  })

  const underIce = new THREE.Mesh(underIceGeometry, underIceMaterial)
  underIce.rotation.x = -Math.PI / 2
  underIce.position.y = -0.08
  scene.add(underIce)

  // 冰面高光闪烁点
  const sparkleGeometry = new THREE.CircleGeometry(0.04, 6)
  const sparkleMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: 0xaaddff,
    emissiveIntensity: 1.0,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide
  })

  for (let i = 0; i < 120; i++) {
    const sparkle = new THREE.Mesh(sparkleGeometry, sparkleMaterial)
    const x = (Math.random() - 0.5) * 22
    const z = (Math.random() - 0.5) * 22
    sparkle.rotation.x = -Math.PI / 2
    sparkle.position.set(x, 0.01, z)
    const size = 0.3 + Math.random() * 1.8
    sparkle.scale.set(size, size, 1)
    sparkle.material = sparkleMaterial.clone()
    sparkle.material.opacity = 0.2 + Math.random() * 0.5
    scene.add(sparkle)
  }

  // --- 雪人 ---
  function createSnowman(posX, posZ, scale = 1.0) {
    const group = new THREE.Group()
    const bodyMat = new THREE.MeshToonMaterial({
      color: 0xf5faff,
      emissive: 0x442266,
      emissiveIntensity: 0.04
    })

    const bottom = new THREE.Mesh(new THREE.SphereGeometry(0.9 * scale, 24, 16), bodyMat)
    bottom.position.y = 0.9 * scale
    bottom.castShadow = true
    bottom.receiveShadow = true
    group.add(bottom)

    const mid = new THREE.Mesh(new THREE.SphereGeometry(0.7 * scale, 24, 16), bodyMat)
    mid.position.y = 1.8 * scale
    mid.castShadow = true
    mid.receiveShadow = true
    group.add(mid)

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.55 * scale, 24, 16), bodyMat)
    head.position.y = 2.6 * scale
    head.castShadow = true
    head.receiveShadow = true
    group.add(head)

    const eyeMat = new THREE.MeshToonMaterial({ color: 0x1a1a2e })
    const eyePos = [
      [-0.2 * scale, 2.7 * scale, 0.45 * scale],
      [0.2 * scale, 2.7 * scale, 0.45 * scale]
    ]
    eyePos.forEach(pos => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08 * scale, 12, 8), eyeMat)
      eye.position.set(pos[0], pos[1], pos[2])
      group.add(eye)
    })

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.1 * scale, 0.3 * scale, 8),
      new THREE.MeshToonMaterial({ color: 0xff8c42 })
    )
    nose.position.set(0, 2.65 * scale, 0.6 * scale)
    nose.rotation.x = 0.2
    group.add(nose)

    const hatMat = new THREE.MeshToonMaterial({ color: 0x2c3e50 })
    const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * scale, 0.65 * scale, 0.25 * scale, 8), hatMat)
    hatBase.position.set(0, 2.9 * scale, 0)
    hatBase.castShadow = true
    group.add(hatBase)

    const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * scale, 0.35 * scale, 0.45 * scale, 8), hatMat)
    hatTop.position.set(0, 3.2 * scale, 0)
    hatTop.castShadow = true
    group.add(hatTop)

    const scarf = new THREE.Mesh(
      new THREE.BoxGeometry(0.8 * scale, 0.12 * scale, 0.5 * scale),
      new THREE.MeshToonMaterial({ color: 0xd64550 })
    )
    scarf.position.set(0, 1.8 * scale, 0.2 * scale)
    scarf.castShadow = true
    group.add(scarf)

    group.position.set(posX, 0, posZ)
    group.rotation.y = (Math.random() - 0.5) * 0.3
    return group
  }

  // ========== 粉红色树木 ==========
  // ========== 树（从 GLB 加载） ==========
  const treePositions = [
    [-7, -7], [9, -6], [-6, 8], [8, 7], [-9, 4], [10, 2],
    [-4.5, -4.5], [5.5, -4], [-3.5, 5.5], [5, 5], [-6, 2.5], [6.5, -4.5],
    [-3, -2.5], [3.5, -3], [-2.5, 3.5], [3, 3.5]
  ]

  const trees = []

  function loadTrees(){
    // 贴图是「黑底白线」的手绘/木纹，反转成「彩底深线」再上色
    function tintImage(url, r, g, b, cb){
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const d = id.data
        for (let i = 0; i < d.length; i += 4) {
          const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
          const shade = 1 - lum  // 反转：线条变深、背景上色
          d[i] = r * shade
          d[i + 1] = g * shade
          d[i + 2] = b * shade
        }
        ctx.putImageData(id, 0, 0)
        cb(canvas)
      }
      img.src = url
    }

    const trunkTex = new THREE.CanvasTexture(document.createElement('canvas'))
    trunkTex.colorSpace = THREE.SRGBColorSpace
    const leafTex = new THREE.CanvasTexture(document.createElement('canvas'))
    leafTex.colorSpace = THREE.SRGBColorSpace
    tintImage(base + 'textures/trunk.jpg', 122, 82, 48, c => { trunkTex.image = c; trunkTex.needsUpdate = true })
    tintImage(base + 'textures/leaves.jpg', 255, 141, 161, c => { leafTex.image = c; leafTex.needsUpdate = true })

    new GLTFLoader().load(base + 'models/flower_tree.glb', gltf=>{
      const template = gltf.scene
      // 归一化：去掉 GLB 里 bake 的原场景位移，让树回到原点
      template.traverse(node => {
        if (node.parent === template) node.position.set(0, 0, 0)
        if (node.isMesh) {
          node.castShadow = true
          node.receiveShadow = true
          const m = node.material
          if (m && m.name === '4.wood') {
            node.material = new THREE.MeshLambertMaterial({ map: trunkTex, side: m.side })
          } else if (m && m.name === 'bush') {
            node.material = new THREE.MeshLambertMaterial({ map: leafTex, side: m.side })
          } else if (m && m.color) {
            node.material = new THREE.MeshLambertMaterial({ color: m.color, side: m.side })
          }
        }
      })
      template.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(template)
      const bottomY = box.min.y
      const h = box.max.y - box.min.y
      const targetH = 4.5  // 目标树高

      treePositions.forEach(([x, z]) => {
        const pivot = new THREE.Group()
        pivot.position.set(x, 0, z)  // 树根（地面）为原点
        pivot.rotation.y = Math.random() * Math.PI * 2
        const tree = template.clone()
        const s = (targetH / h) * (0.8 + Math.random() * 0.4)
        tree.scale.setScalar(s)
        tree.position.y = -bottomY * s  // 树整体上移，让树根对齐 pivot 原点
        pivot.add(tree)
        scene.add(pivot)
        trees.push(pivot)
      })
    })
  }
  loadTrees()

  // ========== 粉色花瓣飘落 ==========
  const petalCanvas = document.createElement('canvas')
  petalCanvas.width = 32
  petalCanvas.height = 32
  const pCtx = petalCanvas.getContext('2d')

  pCtx.save()
  pCtx.translate(16, 16)
  pCtx.beginPath()
  pCtx.ellipse(0, 0, 10, 6, 0, 0, Math.PI * 2)
  pCtx.fillStyle = '#ffb7c5'
  pCtx.fill()
  pCtx.beginPath()
  pCtx.ellipse(4, 0, 8, 5, 0.3, 0, Math.PI * 2)
  pCtx.fillStyle = '#ff8da1'
  pCtx.fill()
  pCtx.restore()

  const petalTexture = new THREE.CanvasTexture(petalCanvas)

  const petalCount = 200
  const petalPositions = new Float32Array(petalCount * 3)
  const petalSpeeds = new Float32Array(petalCount)

  for (let i = 0; i < petalCount; i++) {
    petalPositions[i * 3] = (Math.random() - 0.5) * 35
    petalPositions[i * 3 + 1] = Math.random() * 12 + 2
    petalPositions[i * 3 + 2] = (Math.random() - 0.5) * 35
    petalSpeeds[i] = 0.01 + Math.random() * 0.025
  }

  const petalGeometry = new THREE.BufferGeometry()
  petalGeometry.setAttribute('position', new THREE.BufferAttribute(petalPositions, 3))

  const petalMaterial = new THREE.PointsMaterial({
    color: 0xffb7c5,
    size: 0.25,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    map: petalTexture,
    depthWrite: false,
    sizeAttenuation: true
  })

  const petals = new THREE.Points(petalGeometry, petalMaterial)
  petals.userData = { speeds: petalSpeeds }
  scene.add(petals)

  // --- 圆形雪花粒子 ---
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')

  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 28)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.9)')
  gradient.addColorStop(0.7, 'rgba(230, 245, 255, 0.6)')
  gradient.addColorStop(1, 'rgba(200, 230, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)

  const snowTexture = new THREE.CanvasTexture(canvas)

  const snowCount = 1200
  const snowPositions = new Float32Array(snowCount * 3)
  const snowSpeeds = new Float32Array(snowCount)

  for (let i = 0; i < snowCount; i++) {
    snowPositions[i * 3] = (Math.random() - 0.5) * 40
    snowPositions[i * 3 + 1] = Math.random() * 15
    snowPositions[i * 3 + 2] = (Math.random() - 0.5) * 40
    snowSpeeds[i] = 0.005 + Math.random() * 0.015
  }

  const snowGeometry = new THREE.BufferGeometry()
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowPositions, 3))

  const snowMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.2,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    map: snowTexture,
    depthWrite: false,
    sizeAttenuation: true
  })

  const snowParticles = new THREE.Points(snowGeometry, snowMaterial)
  snowParticles.userData = { speeds: snowSpeeds }
  scene.add(snowParticles)

  // 初始关闭下雪
  snowParticles.visible = false
  let snowStarted = false

  // ================= 风系统 =================
  let windStrength = false

  // 创建按钮
  const windButton = document.createElement("button")
  windButton.innerHTML = "🌬️ 大风"
  windButton.style.position = "fixed"
  windButton.style.right = "30px"
  windButton.style.top = "30px"
  windButton.style.padding = "12px 20px"
  windButton.style.borderRadius = "20px"
  windButton.style.border = "none"
  windButton.style.background = "#ff9eb5"
  windButton.style.color = "white"
  windButton.style.fontSize = "18px"
  windButton.style.cursor = "pointer"
  windButton.style.zIndex = "9999"

  document.body.appendChild(windButton)

  windButton.onclick = () => {
    windStrength = !windStrength

    if (windStrength) {
      windButton.innerHTML = "🌪️ 强风中"
    } else {
      windButton.innerHTML = "🌬️ 微风"
    }
  }

  // --- 氛围光点 ---
  const glowGeometry = new THREE.BufferGeometry()
  const glowCount = 60
  const glowPos = new Float32Array(glowCount * 3)
  for (let i = 0; i < glowCount; i++) {
    glowPos[i * 3] = (Math.random() - 0.5) * 25
    glowPos[i * 3 + 1] = Math.random() * 8 + 1
    glowPos[i * 3 + 2] = (Math.random() - 0.5) * 25
  }
  glowGeometry.setAttribute('position', new THREE.BufferAttribute(glowPos, 3))
  const glowMat = new THREE.PointsMaterial({
    color: 0xffaa66,
    size: 0.08,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending
  })
  const glowPoints = new THREE.Points(glowGeometry, glowMat)
  scene.add(glowPoints)

  // --- 太阳 ---
  const cartoonSunMaterial = new THREE.MeshToonMaterial({
    color: 0xfff1b0,
    emissive: 0xffd56a,
    emissiveIntensity: 0.45
  })
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 8), cartoonSunMaterial)
  sunMesh.position.set(-6, 10, -10)
  scene.add(sunMesh)

  const cartoonSunGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xffe7a0, transparent: true, opacity: 0.08 })
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 8), cartoonSunGlowMaterial)
  glowSphere.position.copy(sunMesh.position)
  scene.add(glowSphere)

  // --- 雪人 ---
  const snowmen = []

  const snowman1 = createSnowman(-1.8, 0.5, 0.9)
  const snowman2 = createSnowman(2.2, -1.2, 0.8)
  const snowman3 = createSnowman(0.5, 2.8, 0.5)

  snowmen.push(snowman1, snowman2, snowman3)

  snowmen.forEach(s => {
    s.userData.clickable = true
    scene.add(s)
  })

  // ================= 点击雪人触发下雪 =================
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

  window.addEventListener("click", (event) => {
    if (state.mode !== 'cartoon') return
    if (event.target !== renderer.domElement) return

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1

    raycaster.setFromCamera(mouse, camera)

    const hits = raycaster.intersectObjects(scene.children, true)

    for (let h of hits) {
      let obj = h.object

      while (obj.parent) {
        if (obj.userData.clickable) {
          snowStarted = true
          snowParticles.visible = true
          return
        }
        obj = obj.parent
      }
    }
  })

  function update(t) {
    // 白云漂浮
    cartoonClouds.forEach(cloud => {
      cloud.position.x = cloud.userData.baseX + Math.sin(t * cloud.userData.speed + cloud.userData.phase) * 1.8
      cloud.position.y = cloud.userData.baseY + Math.sin(t * 0.35 + cloud.userData.phase) * 0.06
    })

    // 雪花下落
    if (!snowStarted) {
      snowParticles.visible = false
    }

    const snowPos = snowParticles.geometry.attributes.position.array
    const snowSpd = snowParticles.userData.speeds
    for (let i = 0; i < snowCount; i++) {
      snowPos[i * 3 + 1] -= snowSpd[i] * (windStrength ? 3 : 0.8)
      snowPos[i * 3] += Math.sin(t * 0.5 + i * 0.1) * 0.002
      snowPos[i * 3 + 2] += Math.cos(t * 0.5 + i * 0.1) * 0.002
      if (snowPos[i * 3 + 1] < -2) {
        snowPos[i * 3 + 1] = 13 + Math.random() * 4
        snowPos[i * 3] = (Math.random() - 0.5) * 40
        snowPos[i * 3 + 2] = (Math.random() - 0.5) * 40
      }
    }
    snowParticles.geometry.attributes.position.needsUpdate = true

    // 花瓣飘落
    const petalPos = petals.geometry.attributes.position.array
    const petalSpd = petals.userData.speeds
    for (let i = 0; i < petalCount; i++) {
      petalPos[i * 3 + 1] -= petalSpd[i] * (windStrength ? 3 : 0.6)
      petalPos[i * 3] += Math.sin(t * 0.8 + i * 0.15) * 0.015
      petalPos[i * 3 + 2] += Math.cos(t * 0.7 + i * 0.12) * 0.015
      petalPos[i * 3] += Math.sin(t + i) * (windStrength ? 0.05 : 0.015)
      if (petalPos[i * 3 + 1] < -1) {
        petalPos[i * 3 + 1] = 12 + Math.random() * 4
        petalPos[i * 3] = (Math.random() - 0.5) * 35
        petalPos[i * 3 + 2] = (Math.random() - 0.5) * 35
      }
    }
    petals.geometry.attributes.position.needsUpdate = true

    // 花瓣旋转感
    petals.rotation.y = Math.sin(t * 0.3) * 0.2

    // 树木随风摇摆
    trees.forEach((tree, index) => {
      if (windStrength) {
        tree.rotation.z = Math.sin(t * 3 + index) * 0.08
      } else {
        tree.rotation.z = Math.sin(t + index) * 0.01
      }
    })
  }

  function render(){ renderer.render(scene, camera) }
  function resize(){ camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix() }

  // ========== 时间变化：白天 / 黄昏 / 夜晚 ==========
  const timeNames = ['白天', '黄昏', '夜晚']
  let timeIndex = 0
  function setTime(next = (timeIndex + 1) % timeNames.length) {
    timeIndex = next
    if (timeIndex === 0) {
      scene.background.set(0x8fd2f5)
      scene.fog.color.set(0xdff3ff); scene.fog.density = 0.006
      sunLight.color.set(0xfff4dc); sunLight.intensity = 1.65
      backLight.color.set(0xb9e3ff); backLight.intensity = 0.5
      fillLight.color.set(0xffffff); fillLight.intensity = 0.65
      ambientLight.color.set(0xd9f1ff); ambientLight.intensity = 0.7
      reflectLight.color.set(0xffffff); reflectLight.intensity = 0.2
      sunLight.position.set(-6, 10, -10)
      treeLight.color.set(0xffffff); treeLight.intensity = 1.3
      glowSphereMat.opacity = 0.9
      glowSphereMat.color.set(0xffffff); rayPlane.material.color.set(0xffffff); rayPlane.material.opacity = 0.3
      cartoonSunMaterial.color.set(0xfff1b0); cartoonSunMaterial.emissive.set(0xffd56a); cartoonSunMaterial.emissiveIntensity = 0.45
      cartoonSunGlowMaterial.color.set(0xffe7a0); cartoonSunGlowMaterial.opacity = 0.08
      cartoonCloudLight.color.set(0xffffff); cartoonCloudShade.color.set(0xd9effa); cartoonCloudLight.opacity = 0.88; cartoonCloudShade.opacity = 0.72
      iceMaterial.color.set(0xffffff); underIceMaterial.color.set(0xeaf7ff); sparkleMaterial.emissive.set(0xffffff); sparkleMaterial.emissiveIntensity = 0.7
      cartoonStars.material.opacity = 0
    } else if (timeIndex === 1) {
      scene.background.set(0xf0a27b)
      scene.fog.color.set(0xf8c38b); scene.fog.density = 0.006
      sunLight.position.set(-6, 2.2, -10)
      sunLight.color.set(0xffae68); sunLight.intensity = 1.35
      backLight.color.set(0x86609e); backLight.intensity = 0.52
      fillLight.color.set(0xffd49a); fillLight.intensity = 0.42
      ambientLight.color.set(0xb87578); ambientLight.intensity = 0.5
      reflectLight.color.set(0xffbd7b); reflectLight.intensity = 0.24
      treeLight.color.set(0xffd9b0); treeLight.intensity = 0.9
      glowSphereMat.opacity = 0.95
      glowSphereMat.color.set(0xffb16d); rayPlane.material.color.set(0xffb16d); rayPlane.material.opacity = 0.46
      cartoonSunMaterial.color.set(0xffb15c); cartoonSunMaterial.emissive.set(0xff6a2e); cartoonSunMaterial.emissiveIntensity = 0.75
      cartoonSunGlowMaterial.color.set(0xff8148); cartoonSunGlowMaterial.opacity = 0.2
      cartoonCloudLight.color.set(0xffd8bd); cartoonCloudShade.color.set(0x87536c); cartoonCloudLight.opacity = 0.75; cartoonCloudShade.opacity = 0.6
      iceMaterial.color.set(0xffdfbd); underIceMaterial.color.set(0xdd9e91); sparkleMaterial.emissive.set(0xffcda0); sparkleMaterial.emissiveIntensity = 0.45
      cartoonStars.material.opacity = 0.08
    } else {
      scene.background.set(0x11143f)
      scene.fog.color.set(0x242452); scene.fog.density = 0.011
      sunLight.position.set(-6, 1, -10)
      sunLight.color.set(0x6574c7); sunLight.intensity = 0.22
      backLight.color.set(0x5b4b9f); backLight.intensity = 0.38
      fillLight.color.set(0x5369b3); fillLight.intensity = 0.18
      ambientLight.color.set(0x313566); ambientLight.intensity = 0.38
      reflectLight.color.set(0x697cff); reflectLight.intensity = 0.12
      treeLight.color.set(0x8fa0d8); treeLight.intensity = 0.35
      glowSphereMat.opacity = 0.35
      glowSphereMat.color.set(0x7182d0); rayPlane.material.color.set(0x7182d0); rayPlane.material.opacity = 0.08
      cartoonSunMaterial.color.set(0x555b99); cartoonSunMaterial.emissive.set(0x20245c); cartoonSunMaterial.emissiveIntensity = 0.15
      cartoonSunGlowMaterial.color.set(0x4f5fb8); cartoonSunGlowMaterial.opacity = 0.05
      cartoonCloudLight.color.set(0x59628e); cartoonCloudShade.color.set(0x292d55); cartoonCloudLight.opacity = 0.3; cartoonCloudShade.opacity = 0.22
      iceMaterial.color.set(0x8095ca); underIceMaterial.color.set(0x4b5a91); sparkleMaterial.emissive.set(0x8da8ff); sparkleMaterial.emissiveIntensity = 0.75
      cartoonStars.material.opacity = 1
    }
    if (timeIndex !== 2) {
      const sunHeight = timeIndex === 0 ? 10 : 2.2
      sunMesh.position.set(-6, sunHeight, -10)
      glowSphere.position.copy(sunMesh.position)
    }
    sunMesh.visible = timeIndex !== 2
    glowSphere.visible = timeIndex !== 2
    return timeNames[timeIndex]
  }

  return { camera, target, update, render, resize, windButton, setTime, getTime: () => timeNames[timeIndex] }
}

// ========== 编排：两个场景 + 切换 ==========
const real = setupReal()
const cartoon = setupCartoon()

let mode = 'real'
state.mode = mode

// 只用一个 OrbitControls，切换时换绑相机，避免两个控制器争抢同一个 DOM 元素导致切回后卡住
const controls = new OrbitControls(real.camera, renderer.domElement)
controls.enableDamping = true

function applyControls(next) {
  if (next === 'real') {
    controls.object = real.camera
    controls.target.copy(real.target)
    controls.dampingFactor = 0.08
    controls.minDistance = 5
    controls.maxDistance = 80
    controls.maxPolarAngle = Math.PI / 2.2
  } else {
    controls.object = cartoon.camera
    controls.target.copy(cartoon.target)
    controls.dampingFactor = 0.05
    controls.minDistance = 0
    controls.maxDistance = Infinity
    controls.maxPolarAngle = Math.PI
  }
  controls.update()
}
applyControls('real')

cartoon.windButton.style.display = 'none'

// 切换按钮
const toggleBtn = document.createElement('button')
toggleBtn.textContent = '🎨 切换到卡通版'
toggleBtn.style.position = 'fixed'
toggleBtn.style.left = '30px'
toggleBtn.style.top = '30px'
toggleBtn.style.padding = '12px 22px'
toggleBtn.style.borderRadius = '22px'
toggleBtn.style.border = 'none'
toggleBtn.style.background = '#6a6ab8'
toggleBtn.style.color = 'white'
toggleBtn.style.fontSize = '18px'
toggleBtn.style.cursor = 'pointer'
toggleBtn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.25)'
toggleBtn.style.zIndex = '9999'
document.body.appendChild(toggleBtn)

// ========== 交互按钮（右上角） ==========
function makeActionBtn(text, bg, top){
  const b = document.createElement('button')
  b.textContent = text
  b.style.position = 'fixed'
  b.style.right = '30px'
  b.style.top = top
  b.style.padding = '12px 20px'
  b.style.borderRadius = '22px'
  b.style.border = 'none'
  b.style.background = bg
  b.style.color = 'white'
  b.style.fontSize = '16px'
  b.style.cursor = 'pointer'
  b.style.boxShadow = '0 4px 14px rgba(0,0,0,0.25)'
  b.style.zIndex = '9999'
  document.body.appendChild(b)
  return b
}
const weatherBtn = makeActionBtn('🌨️ 天气开/关', '#7fb2e0', '30px')
const realBtns = [weatherBtn]
const timeBtn = makeActionBtn('🕒 时间：白天', '#536aa8', '82px')

weatherBtn.addEventListener('click', ()=>{ if(mode==='real') real.toggleWeather() })
timeBtn.addEventListener('click', () => {
  if (mode !== 'cartoon') return
  const nextTime = cartoon.setTime()
  timeBtn.textContent = `🕒 时间：${nextTime}`
})
timeBtn.style.display = 'none'

// 交互提示（底部居中，9 秒后淡出）
const hintEl = document.createElement('div')
hintEl.textContent = '🌨️ 点「天气」按钮：开启/关闭风雪（点雪人也可切换）'
hintEl.style.position = 'fixed'
hintEl.style.left = '50%'
hintEl.style.bottom = '28px'
hintEl.style.transform = 'translateX(-50%)'
hintEl.style.padding = '10px 20px'
hintEl.style.borderRadius = '24px'
hintEl.style.background = 'rgba(0,0,0,0.45)'
hintEl.style.color = '#fff'
hintEl.style.fontSize = '14px'
hintEl.style.pointerEvents = 'none'
hintEl.style.zIndex = '9999'
hintEl.style.whiteSpace = 'nowrap'
hintEl.style.backdropFilter = 'blur(4px)'
document.body.appendChild(hintEl)
setTimeout(() => {
  hintEl.style.transition = 'opacity 1.2s'
  hintEl.style.opacity = '0'
  setTimeout(() => hintEl.remove(), 1200)
}, 9000)

toggleBtn.addEventListener('click', () => {
  if (mode === 'real') {
    mode = 'cartoon'
    toggleBtn.textContent = '🌸 切换到现实版'
    renderer.toneMappingExposure = 1.0
    cartoon.windButton.style.display = 'block'
    realBtns.forEach(b => b.style.display = 'none')
    timeBtn.style.display = 'block'
    timeBtn.textContent = `🕒 时间：${cartoon.getTime()}`
  } else {
    mode = 'real'
    toggleBtn.textContent = '🎨 切换到卡通版'
    renderer.toneMappingExposure = 1.0
    cartoon.windButton.style.display = 'none'
    realBtns.forEach(b => b.style.display = 'block')
    timeBtn.style.display = 'none'
  }
  applyControls(mode)
  state.mode = mode
})

// 窗口自适应
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  real.resize()
  cartoon.resize()
})

// 动画循环
const timer = new THREE.Timer(); timer.connect(document)
let frame = 0
function animate(ts) {
  requestAnimationFrame(animate); frame++
  timer.update(ts); const dt = timer.getDelta()
  controls.update()
  if (mode === 'real') {
    real.update(dt, frame)
    real.render()
  } else {
    cartoon.update(performance.now() * 0.001)
    cartoon.render()
  }
}
animate(0)
