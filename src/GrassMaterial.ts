/**
 * GrassMaterial
 *
 * Grass shader adapted from "Fluffy Grass" by thebenezer
 * https://github.com/thebenezer/FluffyGrass
 * Licensed under the MIT License
 *
 * Modifications:
 * - Removed dat.gui dependency
 * - Adapted update() to accept elapsedTime instead of delta
 * - Updated getShadow() signature for THREE.js r165+
 */

import * as THREE from "three";

interface GrassUniformsInterface {
    uTime?: { value: number };
    uEnableShadows?: { value: boolean };
    uShadowDarkness?: { value: number };
    uGrassLightIntensity?: { value: number };
    uNoiseScale?: { value: number };
    uPlayerPosition?: { value: THREE.Vector3 };
    baseColor?: { value: THREE.Color };
    tipColor1?: { value: THREE.Color };
    tipColor2?: { value: THREE.Color };
    noiseTexture?: { value: THREE.Texture };
    grassAlphaTexture?: { value: THREE.Texture };
}

export class GrassMaterial {
    material: THREE.Material;

    private grassColorProps = {
        baseColor: "#4a5e28",
        tipColor1: "#b8e89a",
        tipColor2: "#2e4f35",
    };

    uniforms: { [key: string]: { value: any } } = {
        uTime: { value: 0 },
        uEnableShadows: { value: true },
        uShadowDarkness: { value: 0.5 },
        uGrassLightIntensity: { value: 1 },
        uNoiseScale: { value: 1.5 },
        uPlayerPosition: { value: new THREE.Vector3() },
        baseColor: { value: new THREE.Color(this.grassColorProps.baseColor) },
        tipColor1: { value: new THREE.Color(this.grassColorProps.tipColor1) },
        tipColor2: { value: new THREE.Color(this.grassColorProps.tipColor2) },
        noiseTexture: { value: new THREE.Texture() },
        grassAlphaTexture: { value: new THREE.Texture() },
    };

    private mergeUniforms(newUniforms?: GrassUniformsInterface) {
        if (!newUniforms) return;
        for (const [key, value] of Object.entries(newUniforms)) {
            if (value && Object.prototype.hasOwnProperty.call(this.uniforms, key)) {
                this.uniforms[key].value = value;
            }
        }
    }

    constructor(grassProps?: GrassUniformsInterface) {
        this.mergeUniforms(grassProps);
        this.material = new THREE.MeshLambertMaterial({
            side: THREE.DoubleSide,
            color: 0x229944,
            transparent: true,
            alphaTest: 0.1,
            shadowSide: 1,
        });
        this.setupGrassMaterial(this.material);
    }

    update(elapsedTime: number) {
        this.uniforms.uTime.value = elapsedTime;
    }

    private setupGrassMaterial(material: THREE.Material) {
        material.onBeforeCompile = (shader) => {
            shader.uniforms = {
                ...shader.uniforms,
                uTime: this.uniforms.uTime,
                uTipColor1: this.uniforms.tipColor1,
                uTipColor2: this.uniforms.tipColor2,
                uBaseColor: this.uniforms.baseColor,
                uEnableShadows: this.uniforms.uEnableShadows,
                uShadowDarkness: this.uniforms.uShadowDarkness,
                uGrassLightIntensity: this.uniforms.uGrassLightIntensity,
                uNoiseScale: this.uniforms.uNoiseScale,
                uNoiseTexture: this.uniforms.noiseTexture,
                uGrassAlphaTexture: this.uniforms.grassAlphaTexture,
            };

            shader.vertexShader = `
      #include <common>
      #include <fog_pars_vertex>
      #include <shadowmap_pars_vertex>
      uniform sampler2D uNoiseTexture;
      uniform float uNoiseScale;
      uniform float uTime;

      varying vec3 vColor;
      varying vec2 vGlobalUV;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec2 vWindColor;

      void main() {
        #include <color_vertex>
        #include <begin_vertex>
        #include <project_vertex>
        #include <fog_vertex>
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <worldpos_vertex>
        #include <shadowmap_vertex>

        vec2 uWindDirection = vec2(1.0, 1.0);
        float uWindAmp   = 0.1;
        float uWindFreq  = 50.;
        float uSpeed     = 1.0;
        float uNoiseFactor  = 5.50;
        float uNoiseSpeed   = 0.001;

        vec2 windDirection = normalize(uWindDirection);
        vec4 modelPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);

        float terrainSize = 8.;
        vGlobalUV = (terrainSize - vec2(modelPosition.xz)) / terrainSize;

        vec4 noise = texture2D(uNoiseTexture, vGlobalUV + uTime * uNoiseSpeed);

        float sinWave = sin(uWindFreq * dot(windDirection, vGlobalUV) + noise.g * uNoiseFactor + uTime * uSpeed) * uWindAmp * (1. - uv.y);

        modelPosition.x += sinWave;
        modelPosition.z += sinWave;
        modelPosition.y += exp(texture2D(uNoiseTexture, vGlobalUV * uNoiseScale).r) * 0.5 * (1. - uv.y);

        vec4 viewPosition      = viewMatrix * modelPosition;
        vec4 projectedPosition = projectionMatrix * viewPosition;
        gl_Position = projectedPosition;

        vUv         = vec2(uv.x, 1. - uv.y);
        vNormal     = normalize(normalMatrix * normal);
        vWindColor  = vec2(sinWave, sinWave);
        vViewPosition = mvPosition.xyz;
      }
      `;

            shader.fragmentShader = `
      #include <alphatest_pars_fragment>
      #include <alphamap_pars_fragment>
      #include <fog_pars_fragment>
      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>

      uniform float uTime;
      uniform vec3  uBaseColor;
      uniform vec3  uTipColor1;
      uniform vec3  uTipColor2;
      uniform sampler2D uGrassAlphaTexture;
      uniform sampler2D uNoiseTexture;
      uniform float uNoiseScale;
      uniform int   uEnableShadows;
      uniform float uGrassLightIntensity;
      uniform float uShadowDarkness;

      varying vec3 vColor;
      varying vec2 vUv;
      varying vec2 vGlobalUV;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec2 vWindColor;

      void main() {
        vec4 grassAlpha     = texture2D(uGrassAlphaTexture, vUv);
        vec4 grassVariation = texture2D(uNoiseTexture, vGlobalUV * uNoiseScale);
        vec3 tipColor       = mix(uTipColor1, uTipColor2, grassVariation.r);

        vec4 diffuseColor   = vec4(mix(uBaseColor, tipColor, vUv.y), step(0.1, grassAlpha.r));
        vec3 grassFinalColor = diffuseColor.rgb * uGrassLightIntensity;

        vec3 geometryPosition  = vViewPosition;
        vec3 geometryNormal    = vNormal;
        vec3 geometryViewDir   = (isOrthographic) ? vec3(0, 0, 1) : normalize(vViewPosition);

        float shadow = 0.0;
        float currentShadow = 0.0;

        if (uEnableShadows == 1) {
          #if (NUM_DIR_LIGHTS > 0)
            DirectionalLight directionalLight;
            #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
              DirectionalLightShadow directionalLightShadow;
            #endif
            #pragma unroll_loop_start
            for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
              directionalLight       = directionalLights[i];
              IncidentLight directLight;
              getDirectionalLightInfo(directionalLight, directLight);
              directionalLightShadow = directionalLightShadows[i];
              currentShadow = getShadow(
                directionalShadowMap[i],
                directionalLightShadow.shadowMapSize,
                directionalLightShadow.shadowIntensity,
                directionalLightShadow.shadowBias,
                directionalLightShadow.shadowRadius,
                vDirectionalShadowCoord[i]
              );
              currentShadow = all(bvec2(directLight.visible, receiveShadow)) ? currentShadow : 1.0;
              float weight  = clamp(pow(length(vDirectionalShadowCoord[i].xy * 2. - 1.), 4.), 0.0, 1.0);
              shadow += mix(currentShadow, 1., weight);
            }
            #pragma unroll_loop_end
          #endif
          grassFinalColor = mix(grassFinalColor, grassFinalColor * uShadowDarkness, 1. - shadow);
        }

        diffuseColor.rgb = clamp(diffuseColor.rgb * shadow, 0.0, 1.0);

        #include <alphatest_fragment>
        gl_FragColor = vec4(grassFinalColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
      `;
        };
    }

    setupTextures(grassAlphaTexture: THREE.Texture, noiseTexture: THREE.Texture) {
        this.uniforms.grassAlphaTexture.value = grassAlphaTexture;
        this.uniforms.noiseTexture.value = noiseTexture;
    }
}