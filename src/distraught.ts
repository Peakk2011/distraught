import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// Types
interface DistraughtOptions {
    /** CSS selector or HTMLElement to mount the canvas into */
    container: string | HTMLElement;

    /** Path to .obj file */
    objFile: string;

    /** Path to .mtl file (optional) */
    mtlFile?: string;

    /** Target rendered size of the model in scene units (default: 8) */
    modelSize?: number;

    /** Called with 0–100 during load */
    onProgress?: (percent: number) => void;

    /** Called once model is fully in scene */
    onLoad?: () => void;

    /** Called if load fails */
    onError?: (err: Error) => void;
}

// Constants
const DEFAULT_CAMERA_PHI = Math.PI / 2.6;
const PAN_DRAG_SPEED = 0.0003;
const SHIFT_WHEEL_PAN_SPEED = 0.00045;
const ORBIT_SMOOTH = 0.12;
const ZOOM_SMOOTH = 0.10;

// Distraught
export default class Distraught {
    // Three.js core
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private model: THREE.Object3D | null = null;

    // Scene helpers
    private ground!: THREE.Mesh;
    private grid!: THREE.GridHelper;
    private contactShadow!: THREE.Mesh;

    // Camera state
    private cameraTheta = Math.PI / 4;
    private cameraPhi = DEFAULT_CAMERA_PHI;
    private targetTheta = Math.PI / 4;
    private targetPhi = DEFAULT_CAMERA_PHI;
    private cameraDistance = 20;
    private targetDistance = 20;
    private minDistance = 5;
    private maxDistance = 100;
    private panTarget = new THREE.Vector3();

    // Pointer state
    private isPointerDown = false;
    private isPanning = false;
    private isShiftPressed = false;
    private activePointer: number | null = null;
    private lastPointerX = 0;
    private lastPointerY = 0;

    // Touch state
    private touchMode: 'orbit' | 'zoom' | null = null;
    private lastPinchDist = 0;

    // Lifecycle
    private rafId: number | null = null;
    private readonly opts: Required<
        Omit<DistraughtOptions, 'onProgress' | 'onLoad' | 'onError'>
    > & Pick<DistraughtOptions, 'onProgress' | 'onLoad' | 'onError'>;

    // constructor 
    constructor(options: DistraughtOptions) {
        this.opts = {
            modelSize: 8,
            mtlFile: '',
            onProgress: undefined,
            onLoad: undefined,
            onError: undefined,
            ...options,
        };

        this.initScene();
        this.initLights();
        this.initGround();
        this.initControls();
        this.loadModel();
        this.loop();
    }

    // Public API

    /** Smoothly reset camera to default angle */
    resetView(): this {
        this.targetTheta = Math.PI / 4;
        this.targetPhi = DEFAULT_CAMERA_PHI;
        this.panTarget.set(0, 0, 0);
        return this;
    }

    /** Immediately set camera theta/phi (radians). Fluent. */
    setAngle(theta: number, phi: number): this {
        this.targetTheta = theta;
        this.targetPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, phi));
        return this;
    }

    /** Set zoom distance directly */
    setDistance(d: number): this {
        this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, d));
        return this;
    }

    /** Replace the current model. Returns a Promise that resolves when done. */
    async load(objFile: string, mtlFile?: string): Promise<this> {
        if (this.model) {
            this.scene.remove(this.model);
            this.model = null;
        }
        await this._loadModel(objFile, mtlFile ?? '');
        return this;
    }

    /** Tear down renderer, cancel animation loop, remove DOM element */
    destroy(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.renderer.domElement.remove();
        this.renderer.dispose();
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }

    // Scene init

    private initScene(): void {
        const container = typeof this.opts.container === 'string'
            ? document.querySelector<HTMLElement>(this.opts.container)!
            : this.opts.container;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0F0F0F);
        this.scene.fog = new THREE.FogExp2(0x0F0F0F, 0.015);

        this.camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 2000);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        window.addEventListener('resize', this._onResize);
    }

    private initLights(): void {
        this.scene.add(new THREE.AmbientLight(0x404060, 0.55));

        const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 0.5);
        this.scene.add(hemi);

        const sun = new THREE.DirectionalLight(0xfff5e6, 3);
        sun.position.set(15, 22, 12);
        sun.castShadow = true;
        sun.shadow.mapSize.set(4096, 4096);
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 200;
        sun.shadow.camera.left = sun.shadow.camera.bottom = -25;
        sun.shadow.camera.right = sun.shadow.camera.top = 25;
        sun.shadow.bias = -0.00005;
        this.scene.add(sun);

        const fill = new THREE.PointLight(0xffaa77, 0.45);
        fill.position.set(-8, 12, 8);
        this.scene.add(fill);

        const rim = new THREE.PointLight(0xffcc88, 0.4);
        rim.position.set(-6, 10, -12);
        this.scene.add(rim);

        const back = new THREE.PointLight(0xffaa66, 0.3);
        back.position.set(5, 8, -10);
        this.scene.add(back);
    }

    private initGround(): void {
        this.ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200, 200),
            new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7, metalness: 0.05 }),
        );
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);

        this.grid = new THREE.GridHelper(200, 80, 0x555555, 0x3a3a3a);
        this.grid.position.y = 0.01;
        this.scene.add(this.grid);

        this.contactShadow = this._makeContactShadow();
        this.scene.add(this.contactShadow);
    }

    // Model loading 
    private loadModel(): void {
        this._loadModel(this.opts.objFile, this.opts.mtlFile ?? '').catch(err => {
            this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
    }

    private async _loadModel(objFile: string, mtlFile: string): Promise<void> {
        const manager = new THREE.LoadingManager();
        const objLoader = new OBJLoader(manager);

        if (mtlFile) {
            const mtlLoader = new MTLLoader(manager);
            mtlLoader.setMaterialOptions({ side: THREE.DoubleSide });
            const materials = await new Promise<MTLLoader.MaterialCreator>((res, rej) => {
                mtlLoader.load(mtlFile, res, undefined, rej);
            });
            materials.preload();
            objLoader.setMaterials(materials);
        }

        const object = await new Promise<THREE.Object3D>((res, rej) => {
            objLoader.load(
                objFile,
                res,
                (e) => {
                    if (e.lengthComputable) {
                        this.opts.onProgress?.(Math.round(e.loaded / e.total * 100));
                    }
                },
                rej,
            );
        });

        this._finalizeModel(object);
        this.model = object;
        this.scene.add(this.model);
        this.opts.onLoad?.();
    }

    private _finalizeModel(object: THREE.Object3D): void {
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) object.scale.setScalar(this.opts.modelSize / maxDim);

        box.setFromObject(object);
        object.position.sub(box.getCenter(new THREE.Vector3()));

        const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

        object.traverse(child => {
            if (!(child instanceof THREE.Mesh)) return;
            child.castShadow = true;
            child.receiveShadow = true;
            child.geometry.computeVertexNormals();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat: THREE.Material) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;

                const std = mat as THREE.MeshStandardMaterial;
                if ('roughness' in std) std.roughness = Math.min(std.roughness, 0.6);
                if ('metalness' in std) std.metalness = Math.max(std.metalness, 0.05);

                // fix moiré — anisotropic filtering on every texture map
                const maps: (THREE.Texture | null)[] = [
                    std.map, std.normalMap, std.roughnessMap,
                    std.metalnessMap, std.aoMap, std.emissiveMap,
                ];
                maps.forEach(tex => {
                    if (!tex) return;
                    tex.anisotropy  = maxAnisotropy;
                    tex.minFilter   = THREE.LinearMipmapLinearFilter;
                    tex.magFilter   = THREE.LinearFilter;
                    tex.needsUpdate = true;
                });

                mat.needsUpdate = true;
            });
        });

        box.setFromObject(object);
        const span = box.getSize(new THREE.Vector3()).length();
        const modelBottom = box.min.y;

        this.ground.position.y = modelBottom;
        this.grid.position.y = modelBottom + 0.01;

        const sw = Math.max(box.max.x - box.min.x, 1.5) * 1.3;
        const sd = Math.max(box.max.z - box.min.z, 1.5) * 1.3;
        this.contactShadow.position.set(
            (box.min.x + box.max.x) * 0.5,
            modelBottom + 0.002,
            (box.min.z + box.max.z) * 0.5,
        );
        this.contactShadow.scale.set(sw, sd, 1);

        this.cameraDistance = this.targetDistance = span * 1.5;
        this.minDistance = span * 0.5;
        this.maxDistance = span * 5;
        this.panTarget.set(0, 0, 0);
        this.resetView();
    }

    // Camera
    private updateCamera(): void {
        this.cameraDistance += (this.targetDistance - this.cameraDistance) * ZOOM_SMOOTH;
        this.cameraTheta += (this.targetTheta - this.cameraTheta) * ORBIT_SMOOTH;
        this.cameraPhi += (this.targetPhi - this.cameraPhi) * ORBIT_SMOOTH;

        const r = this.cameraDistance;
        const x = r * Math.sin(this.cameraPhi) * Math.cos(this.cameraTheta);
        const y = r * Math.cos(this.cameraPhi);
        const z = r * Math.sin(this.cameraPhi) * Math.sin(this.cameraTheta);

        this.camera.position.set(
            x + this.panTarget.x,
            y + this.panTarget.y,
            z + this.panTarget.z,
        );
        this.camera.lookAt(this.panTarget);
    }

    private panScreen(dx: number, dy: number): void {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        right.y = 0;
        right.normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const scale = PAN_DRAG_SPEED * this.cameraDistance;
        this.panTarget.addScaledVector(right, -dx * scale);
        this.panTarget.addScaledVector(up, dy * scale);
    }

    // Controls
    private initControls(): void {
        const el = this.renderer.domElement;
        el.addEventListener('pointerdown', this._onPointerDown);
        el.addEventListener('pointermove', this._onPointerMove);
        el.addEventListener('pointerup', this._onPointerUp);
        el.addEventListener('pointercancel', this._onPointerUp);
        el.addEventListener('wheel', this._onWheel, { passive: false });
        el.addEventListener('touchstart', this._onTouchStart, { passive: false });
        el.addEventListener('touchmove', this._onTouchMove, { passive: false });
        el.addEventListener('touchend', () => { this.isPointerDown = false; this.touchMode = null; this.lastPinchDist = 0; });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    // arrow functions preserve `this`
    private _onPointerDown = (e: PointerEvent): void => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        e.preventDefault();
        this.isPointerDown = true;
        this.activePointer = e.pointerId;
        this.isPanning = e.shiftKey || this.isShiftPressed;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        this.renderer.domElement.setPointerCapture(e.pointerId);
    };

    private _onPointerMove = (e: PointerEvent): void => {
        if (!this.isPointerDown || e.pointerId !== this.activePointer) return;
        e.preventDefault();
        const dx = e.clientX - this.lastPointerX;
        const dy = e.clientY - this.lastPointerY;

        if (this.isPanning || e.shiftKey || this.isShiftPressed) {
            this.panScreen(dx, dy);
        } else {
            this.targetTheta += dx * 0.005;
            this.targetPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, this.targetPhi - dy * 0.005));
        }

        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
    };

    private _onPointerUp = (e: PointerEvent): void => {
        if (this.activePointer !== null && e.pointerId !== this.activePointer) return;
        if (this.activePointer !== null && this.renderer.domElement.hasPointerCapture(this.activePointer)) {
            this.renderer.domElement.releasePointerCapture(this.activePointer);
        }
        this.isPointerDown = false;
        this.isPanning = false;
        this.activePointer = null;
    };

    private _onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (e.shiftKey || this.isShiftPressed) {
            const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            this.panTarget.y -= delta * SHIFT_WHEEL_PAN_SPEED * this.cameraDistance;
            return;
        }
        this.targetDistance *= Math.exp(e.deltaY * 0.001);
        this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDistance));
    };

    private _onTouchStart = (e: TouchEvent): void => {
        e.preventDefault();
        if (e.touches.length === 1) {
            this.touchMode = 'orbit';
            this.isPointerDown = true;
            this.lastPointerX = e.touches[0].clientX;
            this.lastPointerY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            this.touchMode = 'zoom';
            this.isPointerDown = false;
            this.lastPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
            );
        }
    };

    private _onTouchMove = (e: TouchEvent): void => {
        e.preventDefault();
        if (this.touchMode === 'orbit' && e.touches.length === 1 && this.isPointerDown) {
            const dx = e.touches[0].clientX - this.lastPointerX;
            const dy = e.touches[0].clientY - this.lastPointerY;
            this.targetTheta += dx * 0.008;
            this.targetPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, this.targetPhi - dy * 0.008));
            this.lastPointerX = e.touches[0].clientX;
            this.lastPointerY = e.touches[0].clientY;
        } else if (this.touchMode === 'zoom' && e.touches.length === 2) {
            const d = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
            );
            if (this.lastPinchDist > 0) {
                this.targetDistance *= this.lastPinchDist / d;
                this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDistance));
            }
            this.lastPinchDist = d;
        }
    };

    private _onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Shift') this.isShiftPressed = true; };
    private _onKeyUp = (e: KeyboardEvent): void => { if (e.key === 'Shift') this.isShiftPressed = false; };

    private _onResize = (): void => {
        const el = this.renderer.domElement.parentElement!;
        this.camera.aspect = el.clientWidth / el.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(el.clientWidth, el.clientHeight);
    };

    // Animation loop 
    private loop = (): void => {
        this.rafId = requestAnimationFrame(this.loop);
        this.updateCamera();
        this.renderer.render(this.scene, this.camera);
    };

    // Helpers
    private _makeContactShadow(): THREE.Mesh {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d')!;
        const cx = canvas.width / 2, cy = canvas.height / 2, r = canvas.width / 2;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(0,0,0,0.85)');
        g.addColorStop(0.2, 'rgba(0,0,0,0.60)');
        g.addColorStop(0.4, 'rgba(0,0,0,0.35)');
        g.addColorStop(0.6, 'rgba(0,0,0,0.15)');
        g.addColorStop(0.8, 'rgba(0,0,0,0.05)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;

        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshStandardMaterial({
                map: tex, transparent: true, opacity: 0.85,
                depthWrite: false, side: THREE.DoubleSide, color: 0x000000,
            }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 1;
        return mesh;
    }
}