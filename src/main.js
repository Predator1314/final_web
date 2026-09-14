import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { Water } from 'three/addons/objects/Water.js'
import { TextureLoader } from 'three'

// ========== 共享渲染器 ==========
const app = document.getElementById('app')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.55
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
  const sun = new THREE.DirectionalLight(0xffb8c8, 0.35)
  sun.position.set(100, 40, -60); sun.castShadow = true
  sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.near=0.5; sun.shadow.camera.far=200
  sun.shadow.camera.left=-80; sun.shadow.camera.right=80; sun.shadow.camera.top=80; sun.shadow.camera.bottom=-80
  scene.add(sun)
  scene.add(new THREE.AmbientLight(0xffdde8, 0.15))
  scene.add(new THREE.HemisphereLight(0xffc0d0, 0x5a4a5a, 0.08))

  // ========== 天空（大气散射渐变 + FBM 云层 + 太阳，单次着色器绘制） ==========
  const skyGeo = new THREE.SphereGeometry(200, 64, 32)
  const skySunDir = new THREE.Vector3(0, 20, -140).normalize()
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x2a63b0) },   // 天顶深蓝
      uMid:    { value: new THREE.Color(0x86aede) },   // 中段浅蓝
      uHorizon:{ value: new THREE.Color(0xf2c9a0) },   // 地平线暖橙
      uSunDir: { value: skySunDir },
      uOff:    { value: 26.0 },
      uTime:   { value: 0.0 },
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
      uniform float uOff, uTime;
      varying vec3 vW;

      // --- 值噪声 / FBM（用于云层） ---
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
        for (int i = 0; i < 5; i++){
          v += a * noise(p);
          p = r * p * 2.03;
          a *= 0.5;
        }
        return v;
      }

      void main(){
        vec3 w = normalize(vW + vec3(0.0, uOff, 0.0));
        float h = clamp(w.y, 0.0, 1.0);

        // 大气散射式三段渐变：地平线暖橙 -> 中段浅蓝 -> 天顶深蓝
        float t = pow(h, 0.85);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, t));
        col = mix(col, uZenith, smoothstep(0.28, 1.0, t));

        // 地平线附近的暖色大气光晕（米氏散射）
        col += uHorizon * pow(1.0 - h, 3.0) * 0.26;

        // ===== 云层（上半天空，受太阳方向照亮的 FBM 云） =====
        float clMask = smoothstep(0.04, 0.16, w.y) * (1.0 - smoothstep(0.35, 0.60, w.y));
        vec2 cp = w.xz / max(w.y, 0.06) * 0.5;
        cp.x += uTime * 0.004;
        float cNoise = fbm(cp * 1.4);
        float cloud = smoothstep(0.48, 0.72, cNoise) * clMask;
        float sunAmt = clamp(dot(w, uSunDir), 0.0, 1.0);
        vec3 cloudCol = mix(vec3(0.78, 0.80, 0.88), vec3(1.0, 0.98, 0.92), sunAmt);
        col = mix(col, cloudCol, cloud * 0.65);

        // ===== 太阳：亮核 + 内晕 + 外晕 + 米氏散射光柱 =====
        float sun = max(dot(w, uSunDir), 0.0);
        float disc = smoothstep(0.9990, 0.9994, sun);
        col += vec3(1.0, 0.96, 0.86) * disc * 2.2;
        col += vec3(1.0, 0.86, 0.62) * pow(sun, 6.0) * 0.45;
        col += vec3(1.0, 0.72, 0.48) * pow(sun, 2.5) * 0.22;
        col += vec3(1.0, 0.55, 0.30) * pow(sun, 1.2) * 0.10;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  skyMesh.frustumCulled = false
  scene.add(skyMesh)

  // ========== 雪地（贴图） ==========
  const texLoader = new TextureLoader()

  const snowTex = texLoader.load('/models/snow_ground/textures/meshes0__0_baseColor.jpeg')
  snowTex.colorSpace = THREE.SRGBColorSpace
  snowTex.wrapS = snowTex.wrapT = THREE.RepeatWrapping
  snowTex.repeat.set(18, 18)
  snowTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  const snowNormal = texLoader.load('/models/snow_ground/textures/meshes0__0_normal.png')
  snowNormal.wrapS = snowNormal.wrapT = THREE.RepeatWrapping
  snowNormal.repeat.set(18, 18)

  const snowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(200,200),
    new THREE.MeshStandardMaterial({ map: snowTex, normalMap: snowNormal, normalScale: new THREE.Vector2(0.35, 0.35), color: 0xffffff, roughness: 0.85, metalness: 0 })
  )
  snowGround.rotation.x = -Math.PI/2; snowGround.position.y = -2.9; snowGround.receiveShadow = true
  scene.add(snowGround)

  // ========== 水面 ==========
  let waterPlane
  const poolGeo = new THREE.PlaneGeometry(180,180,64,64)
  let wn = null
  try { wn = texLoader.load('/textures/waternormals.jpg'); wn.wrapS=wn.wrapT=THREE.RepeatWrapping } catch(e){}
  waterPlane = new Water(poolGeo, { textureWidth:512,textureHeight:512,waterNormals:wn,alpha:0.65,sunDirection:sun.position.clone().normalize(),sunColor:0xffeedd,waterColor:0x5588aa,distortionScale:2.0,fog:false })
  waterPlane.rotation.x=-Math.PI/2; waterPlane.position.y=-2.88; scene.add(waterPlane)

  // 雪人站立位置（树会避开这里）
  const SNOWMAN_SPOTS = [
    { x: -15, z: -20 },
    { x: 15, z: -20 },
  ]

  // ========== 櫻花樹 ==========
  function loadTrees() {
    const loader = new GLTFLoader()
    for(let i=0;i<25;i++){
      let a, d, x, z
      do {
        a=Math.random()*Math.PI*2; d=5+Math.random()*35
        x=Math.cos(a)*d; z=Math.sin(a)*d
      } while (SNOWMAN_SPOTS.some(s => (x-s.x)**2 + (z-s.z)**2 < 9*9))
      loader.load('/models/laying_under_a_tree_with_pink_leaves_and_wind/scene.gltf', gltf=>{
        const m=gltf.scene; m.position.set(x,-3,z); m.scale.setScalar(0.5+Math.random()*2)
        m.rotation.y=Math.random()*Math.PI*2
        m.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true}})
        scene.add(m)
        if(gltf.animations&&gltf.animations.length){const mx=new THREE.AnimationMixer(m);mx.clipAction(gltf.animations[0]).play();if(!window.treeMixers)window.treeMixers=[];window.treeMixers.push(mx)}
      })
    }
  }

  // ========== 草地 ==========
  function loadGrass() {
    new GLTFLoader().load('/models/animated_grass_-_vegetation/scene.gltf', gltf=>{
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
  function gust(){ wind = 1.0 }

  // ========== 花瓣 ==========
  const petals=[]
  function petalGeo(){const s=new THREE.Shape();s.moveTo(0,0);s.quadraticCurveTo(.04,.04,.04,.16);s.quadraticCurveTo(.02,.24,0,.32);s.quadraticCurveTo(-.02,.28,-.06,.18);s.quadraticCurveTo(-.08,.08,0,0);const g=new THREE.ShapeGeometry(s,8);g.translate(0,-.08,0);g.scale(.9,.6,1);return g}
  const petMat = new THREE.MeshStandardMaterial({color:0xffccdd,transparent:true,opacity:.8,side:THREE.DoubleSide,roughness:.3})
  function initPetals(){
    for(let i=0;i<150;i++){
      const p=new THREE.Mesh(petalGeo(),petMat)
      p.position.set((Math.random()-.5)*60,5+Math.random()*30,(Math.random()-.5)*60)
      p.rotation.set(-Math.PI/2+(Math.random()-.5)*.2,Math.random()*Math.PI*2,Math.random()*Math.PI)
      p.scale.setScalar(.08+Math.random()*.15)
      p.userData={spd:.01+Math.random()*.03,dx:(Math.random()-.5)*.03,dz:(Math.random()-.5)*.03}
      scene.add(p); petals.push(p)
    }
  }
  function updatePetals(dt){
    petals.forEach(p=>{
      p.position.y-=p.userData.spd; p.position.x+=p.userData.dx+wind*0.1*windDir.x; p.position.z+=p.userData.dz+wind*0.1*windDir.z
      p.rotation.y+=.01+wind*.03; p.rotation.x+=.005+wind*.015
      if(p.position.y<-5){p.position.y=25+Math.random()*20;p.position.x=(Math.random()-.5)*60;p.position.z=(Math.random()-.5)*60}
    })
  }

  // ========== 雪花（单个 Points 对象，替代 600 个独立 Mesh，避免卡顿） ==========
  let snowTarget = 600
  let snowTime = 0
  const SNOW_MAX = 1200
  const snowGeo = new THREE.BufferGeometry()
  const snowPos = new Float32Array(SNOW_MAX * 3)
  const snowSpd = new Float32Array(SNOW_MAX)
  for (let i = 0; i < SNOW_MAX; i++) {
    snowPos[i*3]   = (Math.random() - 0.5) * 140
    snowPos[i*3+1] = Math.random() * 45
    snowPos[i*3+2] = (Math.random() - 0.5) * 140
    snowSpd[i] = 0.02 + Math.random() * 0.05
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
        snowTarget = snowTarget === 600 ? 1200 : 600
        snowmen.forEach(s=>s.userData.target=s.userData.base*1.06)
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
  loadTrees(); loadGrass(); initPetals(); createSnowmen(); createClouds()

  function update(dt, frame){
    skyMat.uniforms.uTime.value += dt
    updatePetals(dt); updateSnow(dt); updateClouds(frame)
    wind = Math.max(0, wind - dt*0.6)
    if(window.treeMixers)window.treeMixers.forEach(m=>m.update(dt))
    if(window.grassMixers)window.grassMixers.forEach(m=>m.update(dt))
    if(waterPlane&&waterPlane.material&&waterPlane.material.uniforms&&waterPlane.material.uniforms.time)waterPlane.material.uniforms.time.value+=dt

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

  return { camera, target, update, render, resize }
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
  sunLight.castShadow = true
  scene.add(sunLight)

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
  function createPinkTree(x, z) {
    const group = new THREE.Group()
    const scale = 1.8 + Math.random() * 0.6

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2 * scale, 0.3 * scale, 0.8 * scale, 8),
      new THREE.MeshToonMaterial({ color: 0x5a3d2b })
    )
    trunk.position.y = 0.4 * scale
    trunk.castShadow = true
    trunk.receiveShadow = true
    group.add(trunk)

    const pinkColors = [0xff8da1, 0xffaab8, 0xffb7c5, 0xff6b81, 0xff9eb5]

    const crownMat1 = new THREE.MeshToonMaterial({
      color: pinkColors[Math.floor(Math.random() * pinkColors.length)],
      emissive: 0x552233,
      emissiveIntensity: 0.08
    })
    const crown1 = new THREE.Mesh(new THREE.ConeGeometry(0.9 * scale, 0.7 * scale, 8), crownMat1)
    crown1.position.y = 0.9 * scale
    crown1.castShadow = true
    crown1.receiveShadow = true
    group.add(crown1)

    const crownMat2 = new THREE.MeshToonMaterial({
      color: pinkColors[Math.floor(Math.random() * pinkColors.length)],
      emissive: 0x552233,
      emissiveIntensity: 0.06
    })
    const crown2 = new THREE.Mesh(new THREE.ConeGeometry(0.7 * scale, 0.6 * scale, 8), crownMat2)
    crown2.position.y = 1.4 * scale
    crown2.castShadow = true
    crown2.receiveShadow = true
    group.add(crown2)

    const crownMat3 = new THREE.MeshToonMaterial({
      color: pinkColors[Math.floor(Math.random() * pinkColors.length)],
      emissive: 0x552233,
      emissiveIntensity: 0.05
    })
    const crown3 = new THREE.Mesh(new THREE.ConeGeometry(0.5 * scale, 0.5 * scale, 8), crownMat3)
    crown3.position.y = 1.9 * scale
    crown3.castShadow = true
    crown3.receiveShadow = true
    group.add(crown3)

    if (Math.random() > 0.5) {
      const snowCap = new THREE.Mesh(
        new THREE.ConeGeometry(0.15 * scale, 0.1 * scale, 6),
        new THREE.MeshToonMaterial({ color: 0xf5faff, transparent: true, opacity: 0.6 })
      )
      snowCap.position.y = 2.2 * scale
      group.add(snowCap)
    }

    group.rotation.y = Math.random() * Math.PI * 2
    group.position.set(x, 0, z)
    return group
  }

  const treePositions = [
    [-7, -7], [9, -6], [-6, 8], [8, 7], [-9, 4], [10, 2],
    [-4.5, -4.5], [5.5, -4], [-3.5, 5.5], [5, 5], [-6, 2.5], [6.5, -4.5],
    [-3, -2.5], [3.5, -3], [-2.5, 3.5], [3, 3.5]
  ]

  const trees = []

  treePositions.forEach(([x, z]) => {
    const tree = createPinkTree(x, z)
    trees.push(tree)
    scene.add(tree)
  })

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
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 16, 8),
    new THREE.MeshToonMaterial({
      color: 0xffaa55,
      emissive: 0xff6622,
      emissiveIntensity: 0.8
    })
  )
  sunMesh.position.set(-6, 8, -10)
  scene.add(sunMesh)

  const glowSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 8, 8),
    new THREE.MeshBasicMaterial({
      color: 0xff8844,
      transparent: true,
      opacity: 0.12
    })
  )
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

  return { camera, target, update, render, resize, windButton }
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

toggleBtn.addEventListener('click', () => {
  if (mode === 'real') {
    mode = 'cartoon'
    toggleBtn.textContent = '🌸 切换到现实版'
    renderer.toneMappingExposure = 1.0
    cartoon.windButton.style.display = 'block'
  } else {
    mode = 'real'
    toggleBtn.textContent = '🎨 切换到卡通版'
    renderer.toneMappingExposure = 0.55
    cartoon.windButton.style.display = 'none'
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
