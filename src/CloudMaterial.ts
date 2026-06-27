import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

/**
 * Builds a volumetric cloud material using ray-marching through a 3D noise texture.
 * Adapted from three.js example: webgl_volume_cloud
 */
export class CloudMaterial {

    readonly material: THREE.RawShaderMaterial;
    private _frame = 0;

    constructor(options?: {
        base?: THREE.ColorRepresentation;
        threshold?: number;
        opacity?: number;
        range?: number;
        steps?: number;
    }) {
        const {
            base      = 0xd8e8f0,
            threshold = 0.28,
            opacity   = 0.30,
            range     = 0.12,
            steps     = 60,       // keep low for perf; raise for quality
        } = options ?? {};

        const texture = this._buildTexture();

        const vertexShader = /* glsl */`
            in vec3 position;

            uniform mat4 modelMatrix;
            uniform mat4 modelViewMatrix;
            uniform mat4 projectionMatrix;
            uniform vec3 cameraPos;

            out vec3 vOrigin;
            out vec3 vDirection;

            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vOrigin    = vec3(inverse(modelMatrix) * vec4(cameraPos, 1.0)).xyz;
                vDirection = position - vOrigin;
                gl_Position = projectionMatrix * mvPosition;
            }
        `;

        const fragmentShader = /* glsl */`
            precision highp float;
            precision highp sampler3D;

            uniform mat4 modelViewMatrix;
            uniform mat4 projectionMatrix;

            in vec3 vOrigin;
            in vec3 vDirection;

            out vec4 color;

            uniform vec3      base;
            uniform sampler3D map;
            uniform float     threshold;
            uniform float     range;
            uniform float     opacity;
            uniform float     steps;
            uniform float     frame;

            uint wang_hash(uint seed) {
                seed = (seed ^ 61u) ^ (seed >> 16u);
                seed *= 9u;
                seed = seed ^ (seed >> 4u);
                seed *= 0x27d4eb2du;
                seed = seed ^ (seed >> 15u);
                return seed;
            }

            float randomFloat(inout uint seed) {
                return float(wang_hash(seed)) / 4294967296.;
            }

            vec2 hitBox(vec3 orig, vec3 dir) {
                const vec3 box_min = vec3(-0.5);
                const vec3 box_max = vec3( 0.5);
                vec3 inv_dir  = 1.0 / dir;
                vec3 tmin_tmp = (box_min - orig) * inv_dir;
                vec3 tmax_tmp = (box_max - orig) * inv_dir;
                vec3 tmin = min(tmin_tmp, tmax_tmp);
                vec3 tmax = max(tmin_tmp, tmax_tmp);
                float t0 = max(tmin.x, max(tmin.y, tmin.z));
                float t1 = min(tmax.x, min(tmax.y, tmax.z));
                return vec2(t0, t1);
            }

            float sample1(vec3 p) { return texture(map, p).r; }

            float shading(vec3 coord) {
                float step = 0.01;
                return sample1(coord + vec3(-step)) - sample1(coord + vec3(step));
            }

            vec4 linearToSRGB(in vec4 value) {
                return vec4(
                    mix(pow(value.rgb, vec3(0.41666)) * 1.055 - vec3(0.055),
                        value.rgb * 12.92,
                        vec3(lessThanEqual(value.rgb, vec3(0.0031308)))),
                    value.a
                );
            }

            void main() {
                vec3 rayDir = normalize(vDirection);
                vec2 bounds = hitBox(vOrigin, rayDir);

                if (bounds.x > bounds.y) discard;
                bounds.x = max(bounds.x, 0.0);

                float stepSize = (bounds.y - bounds.x) / steps;

                uint seed = uint(gl_FragCoord.x) * 1973u
                          + uint(gl_FragCoord.y) * 9277u
                          + uint(frame)          * 26699u;

                vec3  size    = vec3(textureSize(map, 0));
                float randNum = randomFloat(seed) * 2.0 - 1.0;
                vec3  p       = vOrigin + bounds.x * rayDir;
                p += rayDir * randNum * (1.0 / size);

                vec4 ac = vec4(base, 0.0);

                for (float i = 0.0; i < steps; i += 1.0) {
                    float d = sample1(p + 0.5);
                    d = smoothstep(threshold - range, threshold + range, d) * opacity;

                    float col = shading(p + 0.5) * 3.0 + ((p.x + p.y) * 0.25) + 0.2;
                    ac.rgb += (1.0 - ac.a) * d * col;
                    ac.a   += (1.0 - ac.a) * d;

                    if (ac.a >= 0.95) break;
                    p += rayDir * stepSize;
                }

                color = linearToSRGB(ac);
                if (color.a == 0.0) discard;
            }
        `;

        this.material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: {
                base:      { value: new THREE.Color(base) },
                map:       { value: texture },
                cameraPos: { value: new THREE.Vector3() },
                threshold: { value: threshold },
                opacity:   { value: opacity },
                range:     { value: range },
                steps:     { value: steps },
                frame:     { value: 0 },
            },
            vertexShader,
            fragmentShader,
            side:        THREE.BackSide,
            transparent: true,
            depthWrite:  false,
        });
    }

    /** Call every frame with the current camera position. */
    update(cameraPos: THREE.Vector3): void {
        this.material.uniforms.cameraPos.value.copy(cameraPos);
        this.material.uniforms.frame.value = this._frame++;
    }

    dispose(): void {
        this.material.uniforms.map.value?.dispose();
        this.material.dispose();
    }

    // Private

    private _buildTexture(): THREE.Data3DTexture {
        const size   = 128;
        const data   = new Uint8Array(size * size * size);
        const scale  = 0.05;
        const perlin = new ImprovedNoise();
        const vec    = new THREE.Vector3();
        let i = 0;

        for (let z = 0; z < size; z++) {
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const d = 1.0 - vec.set(x, y, z).subScalar(size / 2).divideScalar(size).length();
                    data[i++] = (128 + 128 * perlin.noise(
                        x * scale / 1.5,
                        y * scale,
                        z * scale / 1.5,
                    )) * d * d;
                }
            }
        }

        const tex = new THREE.Data3DTexture(data, size, size, size);
        tex.format         = THREE.RedFormat;
        tex.minFilter      = THREE.LinearFilter;
        tex.magFilter      = THREE.LinearFilter;
        tex.unpackAlignment = 1;
        tex.needsUpdate    = true;
        return tex;
    }
}