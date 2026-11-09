(function initMeshDriftShader() {
  const VERT = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
uniform vec4 u_scene;      // resolution.xy, time, colour count
uniform vec4 u_shape;      // scale, intensity, paramA, warp
uniform vec4 u_surface;    // detail, contrast, brightness, saturation
uniform vec4 u_finish;     // hue, vignette, blur, grain
uniform vec4 u_transform;  // seed, rotation, drift, OKLab toggle
uniform vec4 u_space;      // offset.xy, pointer.xy
uniform vec4 u_cursor;

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_paramA u_shape.z
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_oklab u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorEffect u_cursor.y
#define u_cursorStrength u_cursor.z
#define u_cursorRadius u_cursor.w

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  float n = sin(dot(p, vec2(41.0, 289.0)));
  return fract(vec2(15731.743, 7892.321) * n);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
v += a * noise(p);
p = p * 2.03 + vec2(17.0, 9.2);
a *= 0.5;
  }
  return v;
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
step(0.0031308, c));
}
vec3 linToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixColour(vec3 a, vec3 b, float t) {
  if (u_oklab > 0.5) {
vec3 la = linToOklab(srgbToLinear(a));
vec3 lb = linToOklab(srgbToLinear(b));
return clamp(linearToSrgb(oklabToLin(mix(la, lb, t))), 0.0, 1.0);
  }
  return mix(a, b, t);
}

vec3 palette(float x) {
  float n = max(u_colorCount - 1.0, 1.0);
  float f = clamp(x, 0.0, 1.0) * n;
  vec3 col = u_colors[0];
  for (int i = 0; i < 7; i++) {
if (float(i) < n)
  col = mixColour(col, u_colors[i + 1],
    smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
  }
  return col;
}

vec3 hueRotate(vec3 col, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211,
                      0.587, -0.274, -0.523,
                      0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0,
                      0.956, -0.272, -1.106,
                      0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * col;
  float ca = cos(a), sa = sin(a);
  yiq = vec3(yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  return toRGB * yiq;
}

vec3 shade(vec2 uv, vec2 p, float t) {
  vec3 acc = u_colors[0] * 0.15;
  float total = 0.15;
  for (int i = 0; i < 8; i++) {
if (float(i) >= u_colorCount) break;
float fi = float(i);
vec2 c = vec2(
  sin(t * (0.21 + fi * 0.071) + fi * 2.4 + u_seed),
  cos(t * (0.17 + fi * 0.093) + fi * 1.7)) * (0.45 + u_intensity * 0.35);
float w = exp(-dot(p - c, p - c) * 6.0);
acc += u_colors[i] * w;
total += w;
  }
  return acc / total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 screenUv = uv;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
/ min(u_resolution.x, u_resolution.y);
  float cursorMask = 0.0;

  if (u_cursorPresence > 0.001) {
vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
  / min(u_resolution.x, u_resolution.y);
vec2 cursorDelta = p - cursor;
if (u_cursorEffect < 0.5) {
  p += cursor * u_cursorPresence * u_cursorStrength * 0.55;
} else {
  float cursorDistance = length(cursorDelta);
  vec2 cursorDirection = cursorDelta / max(cursorDistance, 0.0001);
  cursorMask = u_cursorPresence
    * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
  if (u_cursorEffect < 1.5) {
    p -= cursorDirection * cursorMask * u_cursorStrength * 0.24;
  } else if (u_cursorEffect < 2.5) {
    float cursorAngle = cursorMask * u_cursorStrength * 2.2;
    float cc = cos(cursorAngle), cs = sin(cursorAngle);
    p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
  } else if (u_cursorEffect < 3.5) {
    float ripple = sin(
      cursorDistance / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0);
    p -= cursorDirection * ripple * cursorMask * u_cursorStrength * 0.07;
  }
}
  }

  uv = p * min(u_resolution.x, u_resolution.y) / u_resolution.xy + 0.5;
  p *= u_scale;
  if (abs(u_rotate) > 0.0001) {
float cr = cos(u_rotate), sr = sin(u_rotate);
p = mat2(cr, -sr, sr, cr) * p;
  }
  p += u_offset;
  if (u_drift > 0.0001)
p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  if (u_warp > 0.0) {
p += u_warp * (vec2(
  fbm(p * u_detail + u_seed),
  fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
  }
  vec3 col;
  if (u_blur > 0.0) {
float e = u_blur;
float pe = e * u_scale;
vec2 uvE = vec2(e) * min(u_resolution.x, u_resolution.y) / u_resolution.xy;
col  = shade(uv, p, u_time) * 0.36;
col += shade(uv + vec2(uvE.x, 0.0), p + vec2(pe, 0.0), u_time) * 0.16;
col += shade(uv - vec2(uvE.x, 0.0), p - vec2(pe, 0.0), u_time) * 0.16;
col += shade(uv + vec2(0.0, uvE.y), p + vec2(0.0, pe), u_time) * 0.16;
col += shade(uv - vec2(0.0, uvE.y), p - vec2(0.0, pe), u_time) * 0.16;
  } else {
col = shade(uv, p, u_time);
  }
  if (abs(u_contrast - 1.0) > 0.0001)
col = (col - 0.5) * u_contrast + 0.5;
  if (abs(u_saturation - 1.0) > 0.0001) {
float luma = dot(col, vec3(0.299, 0.587, 0.114));
col = mix(vec3(luma), col, u_saturation);
  }
  if (abs(u_hue) > 0.0001)
col = hueRotate(col, u_hue);
  if (abs(u_brightness) > 0.0001)
col += u_brightness;
  if (u_vignette > 0.0001) {
float vd = length(screenUv - 0.5) * 1.41421356;
col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
  }
  if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5)
col += (vec3(0.18) + col * 0.12) * cursorMask * u_cursorStrength;
  if (u_grain > 0.0001)
col += (grainHash(
  gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

  const UNIFORMS = {
    colors: [
      [0.09019607843137255, 0.09019607843137255, 0.09019607843137255],
      [0.5686274509803921, 0.7725490196078432, 1],
      [0.22745098039215686, 0.5058823529411764, 0.9647058823529412],
      [0.1450980392156863, 0.38823529411764707, 0.9372549019607843],
      [0.10196078431372549, 0.3058823529411765, 0.8549019607843137],
      [0.10196078431372549, 0.3058823529411765, 0.8549019607843137],
      [0.10196078431372549, 0.3058823529411765, 0.8549019607843137],
      [0.10196078431372549, 0.3058823529411765, 0.8549019607843137]
    ],
    colorCount: 5,
    scale: 1.260,
    intensity: 0.350,
    paramA: 0.280,
    warp: 0.000,
    detail: 1.824,
    contrast: 1.374,
    brightness: -0.020,
    saturation: 0.680,
    hue: 0.0000,
    vignette: 0.540,
    blur: 0.0000,
    grain: 0.220,
    seed: 1.0,
    rotate: 0.0000,
    offsetX: -0.050,
    offsetY: 0.000,
    drift: 0.060,
    cursorEnabled: true,
    cursorEffect: 4.0,
    cursorStrength: 0.500,
    cursorRadius: 0.800,
    oklab: 1.0,
    timeScale: 1.088,
  };

  const canvas = document.getElementById('shader-canvas');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'low-power' });
  if (!gl) return;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };

  const program = gl.createProgram();
  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const loc = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uni = {
    colors: gl.getUniformLocation(program, 'u_colors'),
    scene: gl.getUniformLocation(program, 'u_scene'),
    shape: gl.getUniformLocation(program, 'u_shape'),
    surface: gl.getUniformLocation(program, 'u_surface'),
    finish: gl.getUniformLocation(program, 'u_finish'),
    transform: gl.getUniformLocation(program, 'u_transform'),
    space: gl.getUniformLocation(program, 'u_space'),
    cursor: gl.getUniformLocation(program, 'u_cursor'),
  };

  gl.uniform3fv(uni.colors, new Float32Array(UNIFORMS.colors.flat()));
  gl.uniform4f(uni.shape, UNIFORMS.scale, UNIFORMS.intensity, UNIFORMS.paramA, UNIFORMS.warp);
  gl.uniform4f(uni.surface, UNIFORMS.detail, UNIFORMS.contrast, UNIFORMS.brightness, UNIFORMS.saturation);
  gl.uniform4f(uni.finish, UNIFORMS.hue, UNIFORMS.vignette, UNIFORMS.blur, UNIFORMS.grain);
  gl.uniform4f(uni.transform, UNIFORMS.seed, UNIFORMS.rotate, UNIFORMS.drift, UNIFORMS.oklab);
  gl.uniform4f(uni.cursor, 0, UNIFORMS.cursorEffect, UNIFORMS.cursorStrength, UNIFORMS.cursorRadius);

  let targetX = 0;
  let targetY = 0;
  let targetPresence = 0;
  let mouseX = 0;
  let mouseY = 0;
  let cursorPresence = 0;
  let pointerKnown = false;
  let pointerClientX = 0;
  let pointerClientY = 0;
  let bounds = canvas.getBoundingClientRect();
  let raf = 0;
  let lastNow = null;
  let visible = document.visibilityState === 'visible';
  let inView = true;
  const start = performance.now();
  const timeAnimated = Math.abs(UNIFORMS.timeScale) > 0.0001;

  const resizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rawWidth = Math.max(1, Math.round(window.innerWidth * dpr));
    const rawHeight = Math.max(1, Math.round(window.innerHeight * dpr));
    const pixelScale = Math.min(
      1,
      Math.sqrt(2_000_000 / Math.max(1, rawWidth * rawHeight))
    );
    const width = Math.max(1, Math.round(rawWidth * pixelScale));
    const height = Math.max(1, Math.round(rawHeight * pixelScale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  };

  function requestRender() {
    if (visible && inView && raf === 0) {
      raf = requestAnimationFrame(render);
    }
  }

  const updatePointerTarget = () => {
    if (!pointerKnown || bounds.width === 0 || bounds.height === 0) return;
    const inside =
      pointerClientX >= bounds.left &&
      pointerClientX <= bounds.right &&
      pointerClientY >= bounds.top &&
      pointerClientY <= bounds.bottom;
    if (!inside) {
      targetPresence = 0;
      requestRender();
      return;
    }
    const nextX = ((pointerClientX - bounds.left) / bounds.width) * 2 - 1;
    const nextY = -(((pointerClientY - bounds.top) / bounds.height) * 2 - 1);
    if (targetPresence === 0 && cursorPresence < 0.01) {
      mouseX = nextX;
      mouseY = nextY;
    }
    targetX = nextX;
    targetY = nextY;
    targetPresence = 1;
    requestRender();
  };

  const onPointerMove = (event) => {
    pointerKnown = true;
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    bounds = canvas.getBoundingClientRect();
    updatePointerTarget();
  };

  const onPointerLeave = () => {
    pointerKnown = false;
    targetPresence = 0;
    requestRender();
  };

  const updateLayout = () => {
    bounds = canvas.getBoundingClientRect();
    resizeCanvas();
    updatePointerTarget();
    requestRender();
  };

  window.addEventListener('resize', updateLayout);
  if (UNIFORMS.cursorEnabled) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointercancel', onPointerLeave);
    window.addEventListener('scroll', updateLayout, true);
    window.addEventListener('blur', onPointerLeave);
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
  }

  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    if (visible) requestRender();
    else if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastNow = null;
    }
  });

  function render(now) {
    raf = 0;
    if (!visible || !inView) return;
    const dt = lastNow === null ? 0 : Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;
    const follow = 1 - Math.exp(-12 * dt);
    mouseX += (targetX - mouseX) * follow;
    mouseY += (targetY - mouseY) * follow;
    cursorPresence += (targetPresence - cursorPresence) * follow;
    resizeCanvas();
    const width = canvas.width;
    const height = canvas.height;
    gl.uniform4f(
      uni.scene,
      width,
      height,
      ((now - start) / 1000) * UNIFORMS.timeScale,
      UNIFORMS.colorCount
    );
    gl.uniform4f(
      uni.space,
      UNIFORMS.offsetX,
      UNIFORMS.offsetY,
      mouseX,
      mouseY
    );
    gl.uniform4f(
      uni.cursor,
      UNIFORMS.cursorEnabled ? cursorPresence : 0,
      UNIFORMS.cursorEffect,
      UNIFORMS.cursorStrength,
      UNIFORMS.cursorRadius
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pointerSettling =
      Math.abs(targetX - mouseX) > 0.001 ||
      Math.abs(targetY - mouseY) > 0.001 ||
      Math.abs(targetPresence - cursorPresence) > 0.001;
    if (timeAnimated || pointerSettling) requestRender();
    else lastNow = null;
  }

  updateLayout();
})();

// --- Liquid Metal Button WebGL Shader Engine ---
let setLmSpeed = null;

(function initLiquidMetalShader() {
  const canvas = document.getElementById('lm-shader-canvas');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'low-power' });
  if (!gl) return;

  const VERT = `attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FRAG = `precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform float u_repetition;
uniform float u_softness;
uniform float u_shiftRed;
uniform float u_shiftBlue;
uniform float u_angle;
uniform float u_scale;
uniform float u_offsetX;
uniform float u_offsetY;

void main() {
vec2 st = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
float t = u_time * u_speed * 0.5;

float rad = radians(u_angle);
mat2 rot = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
st = rot * st;
st *= u_scale;
st += vec2(u_offsetX, u_offsetY);

vec2 p = st;
for(int i = 1; i <= 4; i++) {
    float fi = float(i);
    p.x += (0.35 / fi) * sin(fi * u_repetition * p.y + t * 0.9 + fi * 0.8);
    p.y += (0.35 / fi) * cos(fi * u_repetition * p.x + t * 0.9 + fi * 0.8);
}

vec3 norm = normalize(vec3(cos(p.x * 2.2), sin(p.y * 2.2), u_softness + 0.25));
vec3 light = normalize(vec3(0.6, 0.8, 0.9));

float diff = max(dot(norm, light), 0.0);
float spec = pow(max(dot(reflect(-light, norm), vec3(0.0, 0.0, 1.0)), 0.0), 20.0);

float r = sin(p.x * 2.0 + t + u_shiftRed) * 0.5 + 0.5;
float g = sin(p.x * 2.0 + t) * 0.5 + 0.5;
float b = sin(p.x * 2.0 + t - u_shiftBlue) * 0.5 + 0.5;

// Liquid chrome with metallic emerald / cyan sheen
vec3 metal = mix(vec3(0.12, 0.16, 0.20), vec3(0.85, 0.92, 0.98), diff);
metal += vec3(spec * 0.95);
metal += vec3(r * 0.1, g * 0.35, b * 0.2); // Emerald chrome iridescence

gl_FragColor = vec4(clamp(metal, 0.0, 1.0), 1.0);
}`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };

  const prog = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'u_resolution');
  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uSpeed = gl.getUniformLocation(prog, 'u_speed');
  const uRep = gl.getUniformLocation(prog, 'u_repetition');
  const uSoft = gl.getUniformLocation(prog, 'u_softness');
  const uSR = gl.getUniformLocation(prog, 'u_shiftRed');
  const uSB = gl.getUniformLocation(prog, 'u_shiftBlue');
  const uAngle = gl.getUniformLocation(prog, 'u_angle');
  const uScale = gl.getUniformLocation(prog, 'u_scale');
  const uOffX = gl.getUniformLocation(prog, 'u_offsetX');
  const uOffY = gl.getUniformLocation(prog, 'u_offsetY');

  gl.uniform1f(uRep, 4.0);
  gl.uniform1f(uSoft, 0.5);
  gl.uniform1f(uSR, 0.3);
  gl.uniform1f(uSB, 0.3);
  gl.uniform1f(uAngle, 45.0);
  gl.uniform1f(uScale, 8.0);
  gl.uniform1f(uOffX, 0.1);
  gl.uniform1f(uOffY, -0.1);

  let currentSpeed = 0.6;
  setLmSpeed = (s) => { currentSpeed = s; };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width * dpr) || 480;
    const h = Math.round(rect.height * dpr) || 104;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  resize();
  window.addEventListener('resize', resize);

  const startTime = performance.now();
  let rafId = 0;

  function loop(now) {
    if (document.visibilityState === 'visible') {
      const elapsed = (now - startTime) / 1000;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, elapsed);
      gl.uniform1f(uSpeed, currentSpeed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
})();
