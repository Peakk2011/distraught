import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { GrassMaterial } from './GrassMaterial';
import { CloudMaterial } from './CloudMaterial';

interface DistraughtOptions {
    container: string | HTMLElement;
    objFile: string;
    mtlFile?: string;
    modelSize?: number;
    interactive?: boolean;
    backgroundColor?: string | number | [string | number, string | number];
    gridStyle?: 'line' | 'dot';
    onProgress?: (percent: number) => void;
    onLoad?: () => void;
    onError?: (err: Error) => void;
}

const DEFAULT_THETA = Math.PI / 4;
const DEFAULT_CAMERA_PHI = Math.PI / 2.4;
const PAN_DRAG_SPEED = 0.0003;
const SHIFT_WHEEL_PAN = 0.00045;
const ORBIT_SMOOTH = 0.12;
const ZOOM_SMOOTH = 0.08;
const PHI_MIN = 0.05;
const PHI_MAX = Math.PI / 2 - 0.02;

export default class Distraught {

    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private model: THREE.Object3D | null = null;

    private ground!: THREE.Mesh;
    private grid!: THREE.GridHelper;
    private contactShadow!: THREE.Mesh;

    private pedestal: THREE.Mesh | null = null;
    private pedestalGrass: THREE.Mesh | null = null;
    private pedestalGrassInstanced: THREE.InstancedMesh | null = null;

    private grassMaterial: GrassMaterial = new GrassMaterial();
    private grassBladeGeometry: THREE.BufferGeometry | null = null;
    private readonly grassCount = 1500;
    private clock = new THREE.Timer();
    private _pedestalMode = false;
    private _lastBox: THREE.Box3 | null = null;

    private _cloudMat: CloudMaterial | null = null;
    private _cloudMesh: THREE.Mesh | null = null;

    private sun!: THREE.DirectionalLight;
    private _sunAngle = 0;
    private _sunAnimating = false;
    private _sunSpeed = 0.05;

    private cameraTheta = DEFAULT_THETA;
    private cameraPhi = DEFAULT_CAMERA_PHI;
    private targetTheta = DEFAULT_THETA;
    private targetPhi = DEFAULT_CAMERA_PHI;
    private cameraDistance = 20;
    private targetDistance = 20;
    private minDistance = 5;
    private maxDistance = 100;
    private panTarget = new THREE.Vector3();

    private _interactive = true;
    private isPointerDown = false;
    private isPanning = false;
    private isShiftPressed = false;
    private activePointer: number | null = null;
    private lastPointerX = 0;
    private lastPointerY = 0;
    private touchMode: 'orbit' | 'zoom' | null = null;
    private lastPinchDist = 0;
    private rafId: number | null = null;

    private readonly opts: Required<
        Omit<DistraughtOptions, 'onProgress' | 'onLoad' | 'onError'>
    > & Pick<DistraughtOptions, 'onProgress' | 'onLoad' | 'onError'>;

    constructor(options: DistraughtOptions) {
        this.opts = {
            modelSize: 8,
            mtlFile: '',
            interactive: true,
            backgroundColor: 0x0F0F0F,
            gridStyle: 'line',
            onProgress: undefined,
            onLoad: undefined,
            onError: undefined,
            ...options,
        };
        this._interactive = this.opts.interactive;
        this.initScene();
        this.initLights();
        this.initGround();
        this.initControls();
        this.loadModel();
        this.loop();
    }

    // Public API

    resetView(): this {
        this.targetTheta = DEFAULT_THETA;
        this.targetPhi = DEFAULT_CAMERA_PHI;
        this.panTarget.set(0, -0.5, 0);
        return this;
    }

    setAngle(theta: number, phi: number): this {
        this.targetTheta = theta;
        this.targetPhi = Math.max(PHI_MIN, Math.min(PHI_MAX, phi));
        return this;
    }

    setDistance(d: number): this {
        this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, d));
        return this;
    }

    setAngleDirect(theta: number, phi: number): this {
        this.cameraTheta = this.targetTheta = theta;
        this.cameraPhi = this.targetPhi = Math.max(PHI_MIN, Math.min(PHI_MAX, phi));
        return this;
    }

    setDistanceDirect(d: number): this {
        this.cameraDistance = this.targetDistance = Math.max(
            this.minDistance,
            Math.min(this.maxDistance, d),
        );
        return this;
    }

    setPanDirect(x: number, y: number, z: number): this {
        this.panTarget.set(x, y, z);
        return this;
    }

    setInteractive(enabled: boolean): this {
        this._interactive = enabled;
        return this;
    }

    setGridVisible(enabled: boolean): this {
        this.grid.visible = enabled;
        return this;
    }

    setBackground(color: string | number): this {
        const c = new THREE.Color(color);
        this.scene.background = c;
        (this.scene.fog as THREE.FogExp2).color = c;
        return this;
    }

    setSunAngle(angle: number): this {
        this._sunAngle = angle;
        this._updateSunPosition();
        return this;
    }

    setSunAnimating(enabled: boolean, speed = 0.05): this {
        this._sunAnimating = enabled;
        this._sunSpeed = speed;
        return this;
    }

    setCloudVisible(v: boolean): this {
        if (this._cloudMesh) this._cloudMesh.visible = v;
        return this;
    }

    setCloudOpacity(v: number): this {
        if (this._cloudMat) this._cloudMat.material.uniforms.opacity.value = v;
        return this;
    }

    setPedestalMode(enabled: boolean): this {
        this._pedestalMode = enabled;
        this.ground.visible = !enabled;
        this.grid.visible = !enabled;
        this.contactShadow.visible = !enabled;

        if (enabled) {
            if (!this.pedestal) this._buildPedestalObjects();
            if (this.model && this._lastBox) this._fitPedestal(this._lastBox);
            this.pedestal!.visible = true;
            if (this._cloudMesh) this._cloudMesh.visible = true;
        } else {
            if (this.pedestal) this.pedestal.visible = false;
            if (this.pedestalGrass) this.pedestalGrass.visible = false;
            if (this.pedestalGrassInstanced) this.pedestalGrassInstanced.visible = false;
            if (this._cloudMesh) this._cloudMesh.visible = false;
        }
        return this;
    }

    screenshot(type = 'image/png', quality = 1.0): string {
        this.renderer.render(this.scene, this.camera);
        return this.renderer.domElement.toDataURL(type, quality);
    }

    async load(objFile: string, mtlFile?: string): Promise<this> {
        if (this.model) { this.scene.remove(this.model); this.model = null; }
        await this._loadModel(objFile, mtlFile ?? '');
        return this;
    }

    destroy(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        if (this._cloudMat) this._cloudMat.dispose();
        this.renderer.domElement.remove();
        this.renderer.dispose();
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }

    // Scene

    private initScene(): void {
        const container = typeof this.opts.container === 'string'
            ? document.querySelector<HTMLElement>(this.opts.container)!
            : this.opts.container;

        this.scene = new THREE.Scene();

        const bg = this.opts.backgroundColor;

        if (!bg || bg === 'transparent') {
            this.scene.background = null;
            this.scene.fog = null;
        } else if (Array.isArray(bg)) {
            const topColor = new THREE.Color(bg[0]);
            const botColor = new THREE.Color(bg[1]);
            const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
            const skyMat = new THREE.ShaderMaterial({
                side: THREE.BackSide,
                depthWrite: false,
                uniforms: {
                    topColor: { value: topColor },
                    botColor: { value: botColor },
                },
                vertexShader: `
                varying vec3 vWorldPos;
                void main() {
                    vWorldPos = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
                fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 botColor;
                varying vec3 vWorldPos;
                void main() {
                    float t = clamp(vWorldPos.y / 1000.0, 0.0, 1.0);
                    gl_FragColor = vec4(mix(botColor, topColor, t), 1.0);
                }
            `,
            });
            this.scene.add(new THREE.Mesh(skyGeo, skyMat));
            this.scene.fog = new THREE.FogExp2(botColor, 0.025);
        } else {
            const c = new THREE.Color(bg);
            this.scene.background = c;
            this.scene.fog = new THREE.FogExp2(c, 0.015);
        }

        this.camera = new THREE.PerspectiveCamera(
            50,
            container.clientWidth / container.clientHeight,
            0.1,
            2000,
        );

        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            preserveDrawingBuffer: true,
            alpha: true,
            powerPreference: 'high-performance',
        });

        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 3));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        window.addEventListener('resize', this._onResize);
        this._loadGrassAssets();
    }

    // Lights

    private initLights(): void {
        this.scene.add(new THREE.AmbientLight(0x404040, 0.55));
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.6));

        this.sun = new THREE.DirectionalLight(0xfff5e6, 3);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(8192, 8192);
        this.sun.shadow.camera.near = 0.5;
        this.sun.shadow.camera.far = 200;
        this.sun.shadow.camera.left = -25;
        this.sun.shadow.camera.bottom = -25;
        this.sun.shadow.camera.right = 25;
        this.sun.shadow.camera.top = 25;
        this.sun.shadow.bias = -0.00005;
        this.scene.add(this.sun);

        this._updateSunPosition();

        const fill = new THREE.PointLight(0xffaa77, 0.45);
        fill.position.set(-8, 12, 8);
        this.scene.add(fill);

        const rim = new THREE.PointLight(0xffcc88, 0.40);
        rim.position.set(-6, 10, -12);
        this.scene.add(rim);

        const back = new THREE.PointLight(0xffaa66, 0.30);
        back.position.set(5, 8, -10);
        this.scene.add(back);
    }

    private _updateSunPosition(): void {
        const radius = 30;
        const elevation = Math.PI / 3.5;

        this.sun.position.set(
            radius * Math.cos(this._sunAngle),
            radius * Math.sin(elevation),
            radius * Math.sin(this._sunAngle),
        );

        this.sun.color.setHex(0xfff5e6);
        this.sun.intensity = THREE.MathUtils.lerp(
            1.5,
            3.5,
            Math.abs(Math.sin(this._sunAngle)),
        );
    }

    // Ground

    private initGround(): void {
        const bg = this.opts.backgroundColor;
        let groundColor: THREE.Color;

        if (!bg || bg === 'transparent') {
            groundColor = new THREE.Color(0xcccccc);
        } else if (Array.isArray(bg)) {
            groundColor = new THREE.Color(bg[1]).multiplyScalar(1.2);
        } else {
            groundColor = new THREE.Color(bg).multiplyScalar(1.8);
        }

        this.ground = new THREE.Mesh(
            new THREE.PlaneGeometry(2000, 2000),
            new THREE.MeshStandardMaterial({
                color: groundColor,
                roughness: 0.75,
                metalness: 0.0,
            }),
        );
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);

        // ← แก้ตรงนี้
        if (this.opts.gridStyle === 'dot') {
            this.grid = this._buildDotGrid() as any;
        } else {
            this.grid = new THREE.GridHelper(1000, 50, 0x6a6a6a, 0x8a8a8a);
        }
        this.grid.visible = true;
        this.scene.add(this.grid);

        this.contactShadow = this._makeContactShadow();
        this.scene.add(this.contactShadow);
    }

    // Grass assets

    private _loadGrassAssets(): void {
        const textureLoader = new THREE.TextureLoader();
        const gltfLoader = new GLTFLoader();

        const noiseTexture = textureLoader.load('/perlinnoise.webp', (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
        });
        const alphaTexture = textureLoader.load('/grass.jpeg');
        this.grassMaterial.setupTextures(alphaTexture, noiseTexture);

        gltfLoader.load('/grassLODs.glb', (gltf) => {
            gltf.scene.traverse((child) => {
                if (child instanceof THREE.Mesh && child.name.includes('LOD00')) {
                    this.grassBladeGeometry = child.geometry.clone();
                    if (this.grassBladeGeometry) {
                        this.grassBladeGeometry.scale(3, 1, 3);
                    }
                }
            });
        });
    }

    // Pedestal

    private _buildPedestalObjects(): void {
        const mat = new THREE.MeshStandardMaterial({
            color: 0xb8a896,
            roughness: 0.9,
            metalness: 0.0,
        });

        this.pedestal = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 4, 0.06), mat);
        this.pedestal.castShadow = true;
        this.pedestal.receiveShadow = true;
        this.pedestal.visible = false;
        this.scene.add(this.pedestal);

        this.pedestalGrass = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1, 48, 48),
            new THREE.MeshStandardMaterial({ visible: false, side: THREE.DoubleSide }),
        );
        this.pedestalGrass.rotation.x = -Math.PI / 2;
        this.pedestalGrass.receiveShadow = true;
        this.pedestalGrass.visible = false;
        this.scene.add(this.pedestalGrass);
    }

    private _displaceGrassPlane(amplitude: number): void {
        if (!this.pedestalGrass) return;

        this.pedestalGrass.geometry.dispose();
        this.pedestalGrass.geometry = new THREE.PlaneGeometry(1, 1, 48, 48);

        const geo = this.pedestalGrass.geometry;
        const pos = geo.attributes.position as THREE.BufferAttribute;

        for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i);
            const ly = pos.getY(i);

            const n =
                Math.sin(lx * 6.2 + 0.7) * Math.cos(ly * 5.1 + 1.3) * 0.50 +
                Math.sin(lx * 13.7 - 1.1) * Math.cos(ly * 11.9 + 0.5) * 0.30 +
                Math.sin(lx * 27.3 + 2.4) * Math.cos(ly * 23.1 - 0.9) * 0.20;

            const edgeDist = Math.min(
                Math.abs(lx + 0.5),
                Math.abs(0.5 - lx),
                Math.abs(ly + 0.5),
                Math.abs(0.5 - ly),
            );
            const falloff = THREE.MathUtils.smoothstep(edgeDist, 0, 0.12);

            pos.setZ(i, n * amplitude * falloff);
        }

        pos.needsUpdate = true;
        geo.computeVertexNormals();
    }

    private _buildGrassOnPedestal(): void {
        if (!this.grassBladeGeometry || !this.pedestalGrass) return;

        if (this.pedestalGrassInstanced) {
            this.scene.remove(this.pedestalGrassInstanced);
            this.pedestalGrassInstanced.dispose();
            this.pedestalGrassInstanced = null;
        }

        const samplerGeo = this.pedestalGrass.geometry.clone();
        const samplerMesh = new THREE.Mesh(samplerGeo, new THREE.MeshStandardMaterial());
        samplerMesh.rotation.copy(this.pedestalGrass.rotation);
        samplerMesh.position.copy(this.pedestalGrass.position);
        samplerMesh.scale.copy(this.pedestalGrass.scale);
        samplerMesh.updateMatrixWorld(true);
        samplerGeo.applyMatrix4(samplerMesh.matrixWorld);
        samplerGeo.computeVertexNormals();

        const sampler = new MeshSurfaceSampler(
            new THREE.Mesh(samplerGeo, new THREE.MeshStandardMaterial()),
        ).build();

        const instancedMesh = new THREE.InstancedMesh(
            this.grassBladeGeometry,
            this.grassMaterial.material,
            this.grassCount,
        );
        instancedMesh.receiveShadow = true;
        instancedMesh.castShadow = true;

        const position = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3(1, 1, 1);
        const matrix = new THREE.Matrix4();

        const halfW = (this.pedestalGrass.scale.x / 2) * 1.5;
        const halfD = (this.pedestalGrass.scale.y / 2) * 1.0;
        const pcx = this.pedestalGrass.position.x;
        const pcz = this.pedestalGrass.position.z;

        for (let i = 0; i < this.grassCount; i++) {
            sampler.sample(position, normal);

            position.x = THREE.MathUtils.clamp(position.x, pcx - halfW, pcx + halfW);
            position.z = THREE.MathUtils.clamp(position.z, pcz - halfD, pcz + halfD);

            quaternion.setFromUnitVectors(yAxis, normal.normalize());
            quaternion.multiply(
                new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(0, Math.random() * Math.PI * 2, 0),
                ),
            );

            matrix.compose(position, quaternion, scale);
            instancedMesh.setMatrixAt(i, matrix);
        }

        instancedMesh.instanceMatrix.needsUpdate = true;
        this.pedestalGrassInstanced = instancedMesh;
        this.scene.add(this.pedestalGrassInstanced);
    }

    private _buildUnderCloud(
        cx: number,
        cz: number,
        baseY: number,
        pw: number,
        pd: number,
    ): void {
        if (this._cloudMesh) {
            this.scene.remove(this._cloudMesh);
            this._cloudMesh = null;
        }
        if (this._cloudMat) {
            this._cloudMat.dispose();
            this._cloudMat = null;
        }

        this._cloudMat = new CloudMaterial({
            base: 0xddeeff,
            threshold: 0.25,
            opacity: 0.10,
            range: 0.09,
            steps: 40,
        });

        this._cloudMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            this._cloudMat.material,
        );

        const cloudW = pw * 1.8;
        const cloudD = pd * 1.8;
        const cloudH = Math.max(pw, pd) * 1.4;

        this._cloudMesh.scale.set(
            cloudW,
            cloudH,
            cloudD,
        );
        this._cloudMesh.position.set(
            cx,
            baseY - cloudH * 0,
            cz,
        );

        this.scene.add(this._cloudMesh);

        this._cloudMesh.renderOrder = 999;
        this._cloudMat.material.depthWrite = false;
        this._cloudMat.material.depthTest = false;
    }

    private _fitPedestal(box: THREE.Box3): void {
        if (!this.pedestal || !this.pedestalGrass) return;

        const size = box.getSize(new THREE.Vector3());
        const cx = (box.min.x + box.max.x) * 0.5;
        const cz = (box.min.z + box.max.z) * 0.5;

        const padding = 1.3;
        const pw = size.x * padding;
        const pd = size.z * padding;
        const ph = Math.max(size.y * 0.04, 0.06);

        this.pedestal.scale.set(pw, ph, pd);
        this.pedestal.position.set(
            cx,
            box.min.y - ph / 2,
            cz,
        );

        const inset = pw * 0.08;
        this.pedestalGrass.scale.set(
            pw - inset * 2,
            pd - inset * 2,
            1,
        );
        this.pedestalGrass.position.set(
            cx,
            box.min.y + 0.004,
            cz,
        );

        const amplitude = Math.min(ph * 0.40, pw * 0.03);
        this._displaceGrassPlane(amplitude);

        this._buildGrassOnPedestal();
        if (this.pedestalGrassInstanced) this.pedestalGrassInstanced.visible = true;
        this.pedestalGrass.visible = true;

        this._buildUnderCloud(cx, cz, box.min.y - ph, pw, pd);
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
                (
                    [
                        std.map,
                        std.normalMap,
                        std.roughnessMap,
                        std.metalnessMap,
                        std.aoMap,
                        std.emissiveMap,
                    ] as (THREE.Texture | null)[]
                ).forEach(tex => {
                    if (!tex) return;
                    tex.anisotropy = maxAnisotropy;
                    tex.minFilter = THREE.LinearMipmapLinearFilter;
                    tex.magFilter = THREE.LinearFilter;
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
        this.grid.visible = true;

        const sw = Math.max(box.max.x - box.min.x, 1.5) * 1.3;
        const sd = Math.max(box.max.z - box.min.z, 1.5) * 1.3;
        this.contactShadow.position.set(
            (box.min.x + box.max.x) * 0.5,
            modelBottom + 0.002,
            (box.min.z + box.max.z) * 0.5,
        );
        this.contactShadow.scale.set(sw, sd, 1);

        this.cameraDistance = this.targetDistance = span * 2.2;
        this.minDistance = span * 0.5;
        this.maxDistance = span * 5;
        this.panTarget.set(0, 0, 0);
        this.resetView();

        this._lastBox = box;
        if (this._pedestalMode) {
            if (!this.pedestal) this._buildPedestalObjects();
            this._fitPedestal(box);
        }
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
        const s = PAN_DRAG_SPEED * this.cameraDistance;
        this.panTarget.addScaledVector(right, -dx * s);
        this.panTarget.addScaledVector(new THREE.Vector3(0, 1, 0), dy * s);
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
        el.addEventListener('touchend', () => {
            this.isPointerDown = false;
            this.touchMode = null;
            this.lastPinchDist = 0;
        });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    private _onPointerDown = (e: PointerEvent): void => {
        if (!this._interactive || e.pointerType !== 'mouse' || e.button !== 0) return;
        e.preventDefault();
        this.isPointerDown = true;
        this.activePointer = e.pointerId;
        this.isPanning = e.shiftKey || this.isShiftPressed;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        this.renderer.domElement.setPointerCapture(e.pointerId);
    };

    private _onPointerMove = (e: PointerEvent): void => {
        if (!this._interactive || !this.isPointerDown || e.pointerId !== this.activePointer) return;
        e.preventDefault();
        const dx = e.clientX - this.lastPointerX;
        const dy = e.clientY - this.lastPointerY;
        if (this.isPanning || e.shiftKey || this.isShiftPressed) {
            this.panScreen(dx, dy);
        } else {
            this.targetTheta += dx * 0.005;
            this.targetPhi = Math.max(PHI_MIN, Math.min(PHI_MAX, this.targetPhi - dy * 0.005));
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
        if (!this._interactive) return;
        e.preventDefault();
        if (e.shiftKey || this.isShiftPressed) {
            const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            this.panTarget.y -= delta * SHIFT_WHEEL_PAN * this.cameraDistance;
            return;
        }
        this.targetDistance *= Math.exp(e.deltaY * 0.001);
        this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDistance));
    };

    private _onTouchStart = (e: TouchEvent): void => {
        if (!this._interactive) return;
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
        if (!this._interactive) return;
        e.preventDefault();
        if (this.touchMode === 'orbit' && e.touches.length === 1 && this.isPointerDown) {
            const dx = e.touches[0].clientX - this.lastPointerX;
            const dy = e.touches[0].clientY - this.lastPointerY;
            this.targetTheta += dx * 0.008;
            this.targetPhi = Math.max(PHI_MIN, Math.min(PHI_MAX, this.targetPhi - dy * 0.008));
            this.lastPointerX = e.touches[0].clientX;
            this.lastPointerY = e.touches[0].clientY;
        } else if (this.touchMode === 'zoom' && e.touches.length === 2) {
            const d = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
            );
            if (this.lastPinchDist > 0) {
                this.targetDistance *= this.lastPinchDist / d;
                this.targetDistance = Math.max(
                    this.minDistance,
                    Math.min(this.maxDistance, this.targetDistance),
                );
            }
            this.lastPinchDist = d;
        }
    };

    private _onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Shift') this.isShiftPressed = true;
    };

    private _onKeyUp = (e: KeyboardEvent): void => {
        if (e.key === 'Shift') this.isShiftPressed = false;
    };

    private _onResize = (): void => {
        const el = this.renderer.domElement.parentElement!;
        this.camera.aspect = el.clientWidth / el.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(el.clientWidth, el.clientHeight);
    };

    // Loop

    private loop = (): void => {
        this.rafId = requestAnimationFrame(this.loop);
        this.updateCamera();

        if (this._sunAnimating) {
            this._sunAngle += this._sunSpeed * (1 / 60);
            if (this._sunAngle > Math.PI * 2) this._sunAngle -= Math.PI * 2;
            this._updateSunPosition();
        }

        if (this._pedestalMode) {
            this.clock.update();
            this.grassMaterial.update(this.clock.getElapsed());
        }

        if (this._cloudMesh && this._cloudMat) {
            this._cloudMat.update(this.camera.position);
        }

        this.renderer.render(this.scene, this.camera);
    };

    // Helpers

    private _makeContactShadow(): THREE.Mesh {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 1024;
        const ctx = canvas.getContext('2d')!;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const r = canvas.width / 2;
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
                map: tex,
                transparent: true,
                opacity: 0.95,
                depthWrite: false,
                side: THREE.DoubleSide,
                color: 0x000000,
            }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 1;
        return mesh;
    }

    private _buildDotGrid(): THREE.Points {
        const size = 1000;
        const divisions = 50;
        const step = size / divisions;
        const positions: number[] = [];

        for (let x = -size / 2; x <= size / 2; x += step) {
            for (let z = -size / 2; z <= size / 2; z += step) {
                positions.push(x, 0, z);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0x8a8a8a,
            size: 0.08,
            sizeAttenuation: true,
        });

        return new THREE.Points(geo, mat);
    }
}