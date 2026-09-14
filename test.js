import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

console.log('🚀 test.js 已加载');

const app = document.getElementById('app')
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87CEEB)  // 蓝色背景

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(5, 5, 10)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
app.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)

// 添加红色立方体
const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xff0000 })
)
scene.add(cube)

// 添加灯光
const light = new THREE.DirectionalLight(0xffffff, 1)
light.position.set(5, 10, 5)
scene.add(light)
scene.add(new THREE.AmbientLight(0x404060))

function animate() {
    requestAnimationFrame(animate)
    cube.rotation.x += 0.01
    cube.rotation.y += 0.02
    controls.update()
    renderer.render(scene, camera)
}
animate()

console.log('✅ test.js 执行完毕');