// The 3D scene behind BoardView3D: renderer, camera, orbit controls, lights,
// optional grid, view shortcuts with animated fitting, and on-demand rendering
// (a frame is drawn only when something changed, or while an animation or the
// controls' damping is still moving).
import {
  BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, HemisphereLight, LineBasicMaterial, LineSegments,
  MathUtils, Mesh, NeutralToneMapping, PerspectiveCamera, PMREMGenerator, Raycaster, Scene, SRGBColorSpace, Sphere,
  Vector2, Vector3, WebGLRenderer, type Box3, type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import {
  FOV_3D, FOV_PLAN, basis, boxPoints, easeInOutCubic, fit, isoOrientation, lerpPose, planOrientation, planRotated,
  type Pose, type Viewport,
} from './views'

export type ViewCommand = 'top' | 'bottom' | 'iso' | 'fit' | 'reset'

export interface ViewerOptions {
  /** Pixels to keep free around the fitted model (toolbar etc.). */
  insets(): Viewport['inset']
  onContextLost(lost: boolean): void
  /** [P2-d] Called after a frame was drawn (deep links debounce it). */
  onRender?(): void
}

/** The view the camera is currently framed for, until the user moves it. */
type Framed =
  | { kind: 'top' }
  | { kind: 'bottom'; alternate: boolean }
  | { kind: 'iso'; corner: number }
  | { kind: 'fit' }

const ANIM_MS = 320

export class Viewer {
  readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(FOV_3D, 1, 1, 1000)
  private readonly controls: OrbitControls
  private readonly container: HTMLElement
  private readonly opts: ViewerOptions
  private readonly resizeObserver: ResizeObserver
  private model: Object3D | null = null
  private overlay: Object3D | null = null
  private box: Box3 | null = null
  private hull: Float32Array = new Float32Array(0)
  private sphere = new Sphere()
  private grid: LineSegments | null = null
  private gridOn = true
  private gridZ = 0
  private gridRadius = 0
  private framed: Framed | null = null
  private anim: { from: Pose; to: Pose; start: number; duration: number } | null = null
  private frame = 0
  private width = 1
  private height = 1
  private disposed = false

  constructor(container: HTMLElement, opts: ViewerOptions) {
    this.container = container
    this.opts = opts
    // throws when WebGL is unavailable; the caller shows that
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer = renderer
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = NeutralToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.setClearColor(0x000000, 0)
    const canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.touchAction = 'none'
    container.appendChild(canvas)
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    // lighting: a soft room environment (reflections on gold, mask and silkscreen),
    // a key light that follows the camera so either side of the board is lit when
    // facing it, and a faint hemisphere fill
    const pmrem = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    this.scene.environment = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    this.scene.environmentIntensity = 0.55
    const key = new DirectionalLight(0xffffff, 1.5)
    key.position.set(-0.8, 1.0, 0.75)
    key.target = this.camera
    this.camera.add(key)
    this.scene.add(this.camera)
    const hemi = new HemisphereLight(0xdde6f0, 0x2a2622, 0.35)
    hemi.position.set(0, 0, 1)
    this.scene.add(hemi)

    const camera = this.camera
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.14
    controls.zoomToCursor = true
    controls.screenSpacePanning = true
    controls.rotateSpeed = 0.9
    controls.zoomSpeed = 1.2
    controls.addEventListener('change', this.requestRender)
    controls.addEventListener('start', this.onUserStart)
    this.controls = controls

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  // ---- model -------------------------------------------------------------------

  /** Show `object` (or nothing). `view` frames it immediately; by default the current kind of view is kept. */
  setModel(object: Object3D | null, box: Box3 | null, hull?: Float32Array): void {
    if (this.model) this.scene.remove(this.model)
    this.model = object
    this.box = box
    this.hull = box ? (hull && hull.length ? hull : boxPoints(box)) : new Float32Array(0)
    if (object && box) {
      this.scene.add(object)
      box.getBoundingSphere(this.sphere)
      this.buildGrid(box)
      const keep = this.framed && this.framed.kind !== 'fit' ? this.framed : null
      this.framed = keep ?? { kind: 'iso', corner: 0 }
      this.applyFramed(false)
    } else {
      this.removeGrid()
    }
    this.requestRender()
  }

  /** Extra objects drawn with the model, e.g. cross-probe markers (model coordinates). [P2-b] */
  setOverlay(object: Object3D | null): void {
    if (this.overlay) this.scene.remove(this.overlay)
    this.overlay = object
    if (object) this.scene.add(object)
    this.requestRender()
  }

  setGrid(on: boolean): void {
    this.gridOn = on
    if (this.grid) this.grid.visible = on
    this.requestRender()
  }

  // ---- views ---------------------------------------------------------------------

  view(cmd: ViewCommand, animate = true): void {
    if (!this.box) return
    const f = this.framed
    switch (cmd) {
      case 'top': this.framed = { kind: 'top' }; break
      case 'bottom': this.framed = { kind: 'bottom', alternate: f?.kind === 'bottom' ? !f.alternate : false }; break
      case 'iso': this.framed = { kind: 'iso', corner: f?.kind === 'iso' ? (f.corner + 1) % 4 : 0 }; break
      case 'reset': this.framed = { kind: 'iso', corner: 0 }; break
      case 'fit': this.framed = { kind: 'fit' }; break
    }
    this.applyFramed(animate)
  }

  /** Re-centre on the model point under a client position (double-click). */
  focusAt(clientX: number, clientY: number): boolean {
    if (!this.model) return false
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hit = ray.intersectObject(this.model, true)[0]
    if (!hit) return false
    const from = this.currentPose()
    const to: Pose = { ...from, target: hit.point.clone(), quaternion: from.quaternion.clone() }
    this.framed = null
    this.animateTo(to, true)
    return true
  }

  private viewport(): Viewport {
    return { width: this.width, height: this.height, inset: this.opts.insets() }
  }

  private poseFor(framed: Framed): Pose | null {
    const box = this.box
    if (!box) return null
    const vp = this.viewport()
    switch (framed.kind) {
      case 'top': return fit(this.hull, planOrientation('top', planRotated(box, vp)), FOV_PLAN, vp)
      case 'bottom': return fit(this.hull, planOrientation('bottom', planRotated(box, vp), framed.alternate), FOV_PLAN, vp)
      case 'iso': return fit(this.hull, isoOrientation(framed.corner), FOV_3D, vp)
      case 'fit': {
        // keep the direction (of the view being animated to, if any)
        const ref = this.anim ? this.anim.to : this.currentPose()
        return fit(this.hull, ref.quaternion, ref.fov, vp)
      }
    }
  }

  private applyFramed(animate: boolean): void {
    if (!this.framed) return
    const pose = this.poseFor(this.framed)
    if (pose) this.animateTo(pose, animate)
  }

  private currentPose(): Pose {
    const d = this.camera.position.distanceTo(this.controls.target)
    return {
      target: this.controls.target.clone(),
      quaternion: this.camera.quaternion.clone(),
      height: d * Math.tan(MathUtils.degToRad(this.camera.fov) / 2),
      fov: this.camera.fov,
    }
  }

  private animateTo(to: Pose, animate: boolean): void {
    // stop any inertia: capture where we are, let the controls settle, put the camera back
    const from = this.currentPose()
    this.controls.enableDamping = false
    this.controls.update()
    this.controls.enableDamping = true
    if (!animate || reducedMotion()) {
      this.anim = null
      this.applyPose(to)
      this.controls.update()
    } else {
      this.applyPose(from)
      this.anim = { from, to, start: performance.now(), duration: ANIM_MS }
    }
    this.requestRender()
  }

  private applyPose(p: Pose): void {
    const cam = this.camera
    const tan = Math.tan(MathUtils.degToRad(p.fov) / 2)
    const d = p.height / tan
    cam.fov = p.fov
    cam.quaternion.copy(p.quaternion)
    cam.position.copy(p.target).addScaledVector(basis(p.quaternion).back, d)
    this.controls.target.copy(p.target)
    // zoom range in terms of what is visible, whatever the field of view
    const r = Math.max(this.sphere.radius, 1)
    this.controls.minDistance = (r * 0.015) / tan
    this.controls.maxDistance = (r * 6) / tan
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
  }

  private onUserStart = (): void => {
    this.framed = null
    if (this.anim) {
      // hand over where the animation is now; drop the roll the slerp may carry
      this.anim = null
      this.camera.lookAt(this.controls.target)
    }
  }

  // ---- rendering ---------------------------------------------------------------------

  requestRender = (): void => {
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number): void => {
    this.frame = 0
    if (this.disposed) return
    if (this.anim) {
      const a = this.anim
      const t = Math.min(1, (now - a.start) / a.duration)
      const p = lerpPose(a.from, a.to, easeInOutCubic(t), { target: new Vector3(), quaternion: a.from.quaternion.clone(), height: 0, fov: 0 })
      if (t >= 1) {
        this.anim = null
        this.applyPose(a.to)
        this.controls.update()
      } else {
        this.applyPose(p)
        this.requestRender()
      }
    } else {
      this.controls.update()   // emits 'change' (-> next frame) while damping is still moving
    }
    this.render()
  }

  private render(): void {
    // the studio turns with the camera: the same lighting on whichever side is in view
    this.scene.environmentRotation.setFromQuaternion(this.camera.quaternion)
    this.updateClipping()
    this.renderer.render(this.scene, this.camera)
    this.opts.onRender?.()
  }

  // ---- [P2-d] camera as numbers, for deep links ------------------------------------------

  /** target x,y,z, quaternion x,y,z,w, view height, fov; null while a framed view (not moved by the user) is shown. */
  userPose(): number[] | null {
    if (this.framed || this.anim || !this.model) return null
    const p = this.currentPose()
    return [p.target.x, p.target.y, p.target.z, p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w, p.height, p.fov]
  }

  /** Show a pose from userPose() (no animation). */
  setUserPose(v: number[]): void {
    if (v.length !== 9 || !v.every(Number.isFinite) || !this.model) return
    const from = this.currentPose()
    from.target.set(v[0]!, v[1]!, v[2]!)
    from.quaternion.set(v[3]!, v[4]!, v[5]!, v[6]!).normalize()
    this.framed = null
    this.animateTo({ target: from.target, quaternion: from.quaternion, height: Math.max(1e-3, v[7]!), fov: v[8]! > 1 && v[8]! < 120 ? v[8]! : from.fov }, false)
  }

  /** Near/far hugging the model: keeps depth precision for layers 0.012 mm apart. */
  private updateClipping(): void {
    const cam = this.camera
    const s = this.sphere
    let r = Math.max(s.radius, 1)
    const showGrid = !!this.grid && this.gridOn && cam.position.z > this.gridZ
    if (this.grid) this.grid.visible = showGrid
    if (showGrid) r = Math.max(r, this.gridRadius)
    const dc = cam.position.distanceTo(s.center)
    const dt = cam.position.distanceTo(this.controls.target)
    const near = Math.max(dc - r * 1.05, dt * 0.05, 0.005)
    const far = dc + r * 1.05
    if (Math.abs(cam.near - near) > near * 1e-3 || Math.abs(cam.far - far) > far * 1e-3) {
      cam.near = near
      cam.far = Math.max(far, near * 2)
      cam.updateProjectionMatrix()
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    const pr = Math.min(window.devicePixelRatio || 1, 2)
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr)
    if (w === this.width && h === this.height && this.renderer.domElement.width === Math.round(w * pr)) return
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // a view that is still framed is re-framed for the new shape
    if (this.framed && this.box) {
      const pose = this.poseFor(this.framed)
      if (pose) {
        if (this.anim) this.anim.to = pose
        else { this.applyPose(pose); this.controls.update() }
      }
    }
    this.render()   // avoid a stretched frame while resizing
    this.requestRender()
  }

  // ---- grid ---------------------------------------------------------------------

  private buildGrid(box: Box3): void {
    this.removeGrid()
    const step = 10
    const pad = 2 * step
    const x0 = Math.floor((box.min.x - pad) / step) * step, x1 = Math.ceil((box.max.x + pad) / step) * step
    const y0 = Math.floor((box.min.y - pad) / step) * step, y1 = Math.ceil((box.max.y + pad) / step) * step
    const z = box.min.z - 0.5
    const pts: number[] = []
    for (let x = x0; x <= x1 + 1e-6; x += step) pts.push(x, y0, z, x, y1, z)
    for (let y = y0; y <= y1 + 1e-6; y += step) pts.push(x0, y, z, x1, y, z)
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pts, 3))
    const m = new LineBasicMaterial({ color: new Color(0x5a6573), transparent: true, opacity: 0.35, depthWrite: false })
    this.grid = new LineSegments(g, m)
    this.grid.renderOrder = -1
    this.grid.visible = this.gridOn
    this.gridZ = z
    g.computeBoundingSphere()
    this.gridRadius = g.boundingSphere!.center.distanceTo(this.sphere.center) + g.boundingSphere!.radius
    this.scene.add(this.grid)
  }

  private removeGrid(): void {
    if (!this.grid) return
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    ;(this.grid.material as LineBasicMaterial).dispose()
    this.grid = null
  }

  // ---- lifecycle -------------------------------------------------------------------

  private onContextLost = (e: Event): void => {
    e.preventDefault()
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.opts.onContextLost(true)
  }

  private onContextRestored = (): void => {
    this.opts.onContextLost(false)
    this.requestRender()
  }

  /** Remove the model without disposing it (it belongs to the model cache). */
  detachModel(): void {
    if (this.model) this.scene.remove(this.model)
    this.model = null
  }

  dispose(): void {
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.removeEventListener('change', this.requestRender)
    this.controls.removeEventListener('start', this.onUserStart)
    this.controls.dispose()
    this.detachModel()
    this.removeGrid()
    this.scene.environment?.dispose()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('webglcontextlost', this.onContextLost)
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
