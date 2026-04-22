// 3D terrain preview using WebGL2. Mirrors Terrain3DView.cs.
// Drag = orbit, wheel = zoom. Render modes: zone color or textured.

import { groupColor } from './markers.js';

const TILE = 4.0;
const HEIGHT_SCALE = 1.0;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aTexIdx;
layout(location=3) in vec3 aNormal;
uniform mat4 uMVP;
out vec2 vUV;
flat out float vTexIdx;
out vec3 vNormal;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vUV = aUV; vTexIdx = aTexIdx; vNormal = aNormal;
}`;
const FS = `#version 300 es
precision highp float;
in vec2 vUV;
flat in float vTexIdx;
in vec3 vNormal;
uniform sampler2D uTexLow;
uniform sampler2D uTexMid;
uniform sampler2D uTexHigh;
uniform sampler2D uTexWater;
uniform bool uTextured;
uniform vec3 uLightDir;
uniform vec3 uLowColor;
uniform vec3 uMidColor;
uniform vec3 uHighColor;
uniform vec3 uWaterColor;
out vec4 frag;
void main() {
  int idx = int(round(vTexIdx));
  vec3 color;
  if (idx == -1) color = uTextured ? texture(uTexWater, vUV).rgb : uWaterColor;
  else if (uTextured) {
    if (idx == 0)      color = texture(uTexLow,  vUV).rgb;
    else if (idx == 1) color = texture(uTexMid,  vUV).rgb;
    else               color = texture(uTexHigh, vUV).rgb;
  } else {
    if (idx == 0)      color = uLowColor;
    else if (idx == 1) color = uMidColor;
    else               color = uHighColor;
  }
  float ndotl = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
  float br = 0.45 + ndotl * 0.55;
  frag = vec4(color * br, 1.0);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMVP;
out vec3 vColor;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); vColor = aColor; }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 frag;
void main() { frag = vec4(vColor, 1.0); }`;

export class Terrain3D {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) {
      this._noGL = true;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f88'; ctx.font = '14px sans-serif';
      ctx.fillText('WebGL2 not available in this browser.', 16, 24);
      return;
    }
    this.gl = gl;
    this._initGL();

    this.heightmap = null;
    this.terrain = null;
    this.markers = null;
    this.track = null;
    this.textured = false;

    this.azimuth = Math.PI / 4;
    this.elevation = Math.PI / 5;
    this.distance = 300;

    this._dirty = { mesh: true, track: true, markers: true, textures: true };
    this._dragging = false;

    canvas.addEventListener('mousedown', e => this.onDown(e));
    window.addEventListener('mousemove', e => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this._raf = null;
    this._scheduleDraw();
  }

  _initGL() {
    const gl = this.gl;
    gl.clearColor(0.06, 0.06, 0.10, 1);
    gl.enable(gl.DEPTH_TEST);

    this.prog = this._link(VS, FS);
    this.lineProg = this._link(LINE_VS, LINE_FS);

    this.uMVP = gl.getUniformLocation(this.prog, 'uMVP');
    this.uLightDir = gl.getUniformLocation(this.prog, 'uLightDir');
    this.uTextured = gl.getUniformLocation(this.prog, 'uTextured');
    this.uTexLow = gl.getUniformLocation(this.prog, 'uTexLow');
    this.uTexMid = gl.getUniformLocation(this.prog, 'uTexMid');
    this.uTexHigh = gl.getUniformLocation(this.prog, 'uTexHigh');
    this.uTexWater = gl.getUniformLocation(this.prog, 'uTexWater');
    this.uLowColor = gl.getUniformLocation(this.prog, 'uLowColor');
    this.uMidColor = gl.getUniformLocation(this.prog, 'uMidColor');
    this.uHighColor = gl.getUniformLocation(this.prog, 'uHighColor');
    this.uWaterColor = gl.getUniformLocation(this.prog, 'uWaterColor');
    this.uLineMVP = gl.getUniformLocation(this.lineProg, 'uMVP');

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.lineVao = gl.createVertexArray();
    this.lineVbo = gl.createBuffer();
    this.markerVao = gl.createVertexArray();
    this.markerVbo = gl.createBuffer();
    this.vertexCount = 0;
    this.lineVertexCount = 0;
    this.markerVertexCount = 0;

    this.glTex = { low: null, mid: null, high: null, water: null };
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('shader: ' + gl.getShaderInfoLog(sh) + '\n' + src);
    return sh;
  }
  _link(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  resize() {
    if (this._noGL) return;
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this._scheduleDraw();
  }

  setHeightmap(hm, terrain) {
    this.heightmap = hm; this.terrain = terrain;
    if (hm) this.distance = Math.max(hm.width, hm.height) * TILE * 0.9;
    this._dirty.mesh = true; this._dirty.track = true; this._dirty.markers = true;
    this._scheduleDraw();
  }
  setTerrain(t) { this.terrain = t; this._dirty.mesh = true; this._scheduleDraw(); }
  setTextured(b) { this.textured = b; this._dirty.mesh = true; this._scheduleDraw(); }
  setTrack(t) { this.track = t; this._dirty.track = true; this._scheduleDraw(); }
  setMarkers(m) { this.markers = m; this._dirty.markers = true; this._scheduleDraw(); }
  markDirty() { this._dirty.mesh = true; this._dirty.track = true; this._dirty.markers = true; this._scheduleDraw(); }

  setTextureImages(imgs) {
    if (this._noGL) return;
    const gl = this.gl;
    const upload = (img, slot) => {
      if (!img) return null;
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      return t;
    };
    if (this.glTex.low) gl.deleteTexture(this.glTex.low);
    if (this.glTex.mid) gl.deleteTexture(this.glTex.mid);
    if (this.glTex.high) gl.deleteTexture(this.glTex.high);
    if (this.glTex.water) gl.deleteTexture(this.glTex.water);
    this.glTex.low = upload(imgs.low, 0);
    this.glTex.mid = upload(imgs.mid, 1);
    this.glTex.high = upload(imgs.high, 2);
    this.glTex.water = upload(imgs.water, 3);
    this._scheduleDraw();
  }

  resetCamera() {
    this.azimuth = Math.PI / 4;
    this.elevation = Math.PI / 5;
    if (this.heightmap)
      this.distance = Math.max(this.heightmap.width, this.heightmap.height) * TILE * 0.9;
    this._scheduleDraw();
  }

  // ───── Mouse ─────

  onDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    this._dragging = true;
    this._dragStart = [e.clientX, e.clientY, this.azimuth, this.elevation];
    this.canvas.style.cursor = 'grabbing';
  }
  onMove(e) {
    if (!this._dragging) return;
    const [sx, sy, az, el] = this._dragStart;
    this.azimuth = az - (e.clientX - sx) * 0.005;
    this.elevation = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, el + (e.clientY - sy) * 0.005));
    this._scheduleDraw();
  }
  onUp() { this._dragging = false; this.canvas.style.cursor = 'grab'; }
  onWheel(e) {
    e.preventDefault();
    this.distance = Math.max(20, Math.min(2000, this.distance * (e.deltaY < 0 ? 0.9 : 1.1)));
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this._raf || this._noGL) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
  }

  // ───── Mesh build ─────

  _rebuildMesh() {
    const gl = this.gl;
    const hm = this.heightmap, t = this.terrain;
    if (!hm || !t) { this.vertexCount = 0; this._dirty.mesh = false; return; }
    const w = hm.width, h = hm.height;
    const tx = w - 1, tz = h - 1;
    if (tx <= 0 || tz <= 0) { this.vertexCount = 0; return; }

    // 6 verts per quad, 9 floats per vert
    const verts = new Float32Array(tx * tz * 6 * 9);
    let v = 0;

    const get = (x, y) => hm.data[y * w + x];

    for (let z = 0; z < tz; z++) {
      for (let x = 0; x < tx; x++) {
        const h00 = get(x, z), h10 = get(x + 1, z);
        const h01 = get(x, z + 1), h11 = get(x + 1, z + 1);
        const x0 = x * TILE, x1 = (x + 1) * TILE;
        const z0 = z * TILE, z1 = (z + 1) * TILE;
        const y00 = h00 * HEIGHT_SCALE, y10 = h10 * HEIGHT_SCALE;
        const y01 = h01 * HEIGHT_SCALE, y11 = h11 * HEIGHT_SCALE;
        const avg = (h00 + h10 + h01 + h11) >> 2;
        let texIdx;
        if (t.hasWater && avg === 0) texIdx = -1;
        else if (avg >= t.midToHigh) texIdx = 2;
        else if (avg >= t.lowToMid) texIdx = 1;
        else texIdx = 0;

        const p0 = [x0, y00, z0], p1 = [x1, y10, z0];
        const p2 = [x1, y11, z1], p3 = [x0, y01, z1];
        const n1 = normalize(cross(sub(p1, p0), sub(p3, p0)));
        const n2 = normalize(cross(sub(p2, p1), sub(p3, p1)));

        v = put(verts, v, x0, y00, z0, 0, 0, texIdx, n1);
        v = put(verts, v, x1, y10, z0, 1, 0, texIdx, n1);
        v = put(verts, v, x0, y01, z1, 0, 1, texIdx, n1);
        v = put(verts, v, x1, y10, z0, 1, 0, texIdx, n2);
        v = put(verts, v, x1, y11, z1, 1, 1, texIdx, n2);
        v = put(verts, v, x0, y01, z1, 0, 1, texIdx, n2);
      }
    }

    this.vertexCount = v / 9;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    const stride = 9 * 4;
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 5 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.bindVertexArray(null);
    this._dirty.mesh = false;
  }

  _rebuildTrack() {
    const gl = this.gl;
    this._dirty.track = false;
    this.lineVertexCount = 0;
    if (!this.track || this.track.checkpoints.length < 2 || !this.heightmap) return;
    const cps = this.track.checkpoints, hm = this.heightmap;
    const halfW = this.track.width / 2 * TILE;
    const yOff = 0.5;
    const getY = (tx, tz) => hm.get(
      Math.max(0, Math.min(hm.width - 1, tx)),
      Math.max(0, Math.min(hm.height - 1, tz))) * HEIGHT_SCALE + yOff;

    const centers = cps.map(cp => [cp.X * TILE, getY(cp.X, cp.Z), cp.Z * TILE]);
    const data = [];
    const addLine = (a, b, r, g, bl) => {
      data.push(a[0], a[1], a[2], r, g, bl, b[0], b[1], b[2], r, g, bl);
    };
    for (let i = 0; i < cps.length; i++) {
      const next = (i + 1) % cps.length;
      const c1 = centers[i], c2 = centers[next];
      const dx = c2[0] - c1[0], dz = c2[2] - c1[2];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const dxn = dx / len, dzn = dz / len;
      const px = -dzn * halfW, pz = dxn * halfW;
      addLine([c1[0]+px, c1[1], c1[2]+pz], [c2[0]+px, c2[1], c2[2]+pz], 1, 0.8, 0.2);
      addLine([c1[0]-px, c1[1], c1[2]-pz], [c2[0]-px, c2[1], c2[2]-pz], 1, 0.8, 0.2);
      addLine(c1, c2, 0.5, 0.4, 0.1);
    }
    for (let i = 0; i < cps.length; i++) {
      const c = centers[i];
      const prev = (i - 1 + cps.length) % cps.length;
      const next = (i + 1) % cps.length;
      const tdx = centers[next][0] - centers[prev][0];
      const tdz = centers[next][2] - centers[prev][2];
      const tlen = Math.hypot(tdx, tdz);
      let dxn = 1, dzn = 0;
      if (tlen >= 0.01) { dxn = tdx / tlen; dzn = tdz / tlen; }
      const gx = -dzn * halfW, gz = dxn * halfW;
      const cR = i === 0 ? [0.2, 1, 0.2] : [1, 1, 1];
      const gateL = [c[0] + gx, c[1], c[2] + gz];
      const gateR = [c[0] - gx, c[1], c[2] - gz];
      addLine(gateL, gateR, cR[0], cR[1], cR[2]);
      const postH = cps[i].HeightAboveGround * HEIGHT_SCALE;
      addLine(gateL, [gateL[0], gateL[1] + postH, gateL[2]], cR[0], cR[1], cR[2]);
      addLine(gateR, [gateR[0], gateR[1] + postH, gateR[2]], cR[0], cR[1], cR[2]);
      addLine([gateL[0], gateL[1] + postH, gateL[2]],
              [gateR[0], gateR[1] + postH, gateR[2]], cR[0], cR[1], cR[2]);
    }
    const arr = new Float32Array(data);
    this.lineVertexCount = arr.length / 6;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    const stride = 6 * 4;
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(1);
    gl.bindVertexArray(null);
  }

  _rebuildMarkers() {
    const gl = this.gl;
    this._dirty.markers = false;
    this.markerVertexCount = 0;
    if (!this.markers || !this.markers.markers.length || !this.heightmap) return;
    const hm = this.heightmap;
    const data = [];
    const addLine = (a, b, r, g, bl) => {
      data.push(a[0], a[1], a[2], r, g, bl, b[0], b[1], b[2], r, g, bl);
    };
    for (const m of this.markers.markers) {
      const wx = m.X * TILE, wz = m.Z * TILE;
      const th = hm.get(
        Math.max(0, Math.min(hm.width - 1, m.X)),
        Math.max(0, Math.min(hm.height - 1, m.Z)));
      const groundY = th * HEIGHT_SCALE + 0.5;
      const markerY = groundY + (m.HeightOffset || 0) * HEIGHT_SCALE;
      const c = groupColor(m.Group);
      const cr = c[0] / 255, cg = c[1] / 255, cb = c[2] / 255;
      if (m.HeightOffset > 0)
        addLine([wx, groundY, wz], [wx, markerY, wz], cr * 0.6, cg * 0.6, cb * 0.6);
      const ds = 2;
      addLine([wx - ds, markerY, wz], [wx + ds, markerY, wz], cr, cg, cb);
      addLine([wx, markerY, wz - ds], [wx, markerY, wz + ds], cr, cg, cb);
      addLine([wx, markerY, wz], [wx, markerY + ds, wz], cr, cg, cb);
    }
    const arr = new Float32Array(data);
    this.markerVertexCount = arr.length / 6;
    gl.bindVertexArray(this.markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    const stride = 6 * 4;
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(1);
    gl.bindVertexArray(null);
  }

  // ───── Render ─────

  render() {
    if (this._noGL) return;
    const gl = this.gl;
    if (this._dirty.mesh) this._rebuildMesh();
    if (this._dirty.track) this._rebuildTrack();
    if (this._dirty.markers) this._rebuildMarkers();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.vertexCount === 0 || !this.heightmap || !this.terrain) return;

    const hm = this.heightmap;
    const cx = hm.width * TILE / 2, cz = hm.height * TILE / 2;
    const ex = cx + Math.sin(this.azimuth) * Math.cos(this.elevation) * this.distance;
    const ey = Math.sin(this.elevation) * this.distance;
    const ez = cz + Math.cos(this.azimuth) * Math.cos(this.elevation) * this.distance;
    const view = lookAt([ex, ey, ez], [cx, 0, cz], [0, 1, 0]);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = perspective(Math.PI / 3, aspect, 1, 3000);
    const mvp = mul(proj, view);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uMVP, false, mvp);
    gl.uniform3f(this.uLightDir, -0.866, 0.5, -0.2);
    gl.uniform1i(this.uTextured, this.textured ? 1 : 0);
    if (this.glTex.low)   { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.glTex.low);   gl.uniform1i(this.uTexLow, 0); }
    if (this.glTex.mid)   { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.glTex.mid);   gl.uniform1i(this.uTexMid, 1); }
    if (this.glTex.high)  { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.glTex.high);  gl.uniform1i(this.uTexHigh, 2); }
    if (this.glTex.water) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.glTex.water); gl.uniform1i(this.uTexWater, 3); }
    const t = this.terrain;
    gl.uniform3f(this.uLowColor,  t.lowColor[0]/255,  t.lowColor[1]/255,  t.lowColor[2]/255);
    gl.uniform3f(this.uMidColor,  t.midColor[0]/255,  t.midColor[1]/255,  t.midColor[2]/255);
    gl.uniform3f(this.uHighColor, t.highColor[0]/255, t.highColor[1]/255, t.highColor[2]/255);
    gl.uniform3f(this.uWaterColor,t.waterColor[0]/255,t.waterColor[1]/255,t.waterColor[2]/255);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.bindVertexArray(null);

    if (this.lineVertexCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.uLineMVP, false, mvp);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
      gl.bindVertexArray(null);
    }
    if (this.markerVertexCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.uLineMVP, false, mvp);
      gl.bindVertexArray(this.markerVao);
      gl.drawArrays(gl.LINES, 0, this.markerVertexCount);
      gl.bindVertexArray(null);
    }
  }
}

// ───── tiny vec/mat helpers ─────
function put(v, i, x, y, z, u, vv, t, n) {
  v[i++]=x; v[i++]=y; v[i++]=z; v[i++]=u; v[i++]=vv; v[i++]=t;
  v[i++]=n[0]; v[i++]=n[1]; v[i++]=n[2]; return i;
}
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-6 ? [0,1,0] : [v[0]/l, v[1]/l, v[2]/l];
}
function lookAt(eye, c, up) {
  const f = normalize(sub(c, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
