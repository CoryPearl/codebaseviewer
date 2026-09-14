const VERTICES = new Float32Array([
  // top
  0,0,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1, 0,1,1,
  // front
  0,1,0, 1,1,0, 1,1,1, 0,1,0, 1,1,1, 0,1,1,
  // back
  1,0,0, 0,0,0, 0,0,1, 1,0,0, 0,0,1, 1,0,1,
  // left
  0,0,0, 0,1,0, 0,1,1, 0,0,0, 0,1,1, 0,0,1,
  // right
  1,1,0, 1,0,0, 1,0,1, 1,1,0, 1,0,1, 1,1,1,
  // bottom
  0,1,0, 0,0,0, 1,0,0, 0,1,0, 1,0,0, 1,1,0,
]);

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aUnit;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aColorHeight;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uZoom;
uniform float uMode;
uniform vec2 uOrbit;
uniform float uDistance;
out vec4 vColor;
out vec3 vUnit;
out float vFace;
void main(){
  float height = max(1.0, aColorHeight.a);
  vec3 world = vec3(aRect.xy + aUnit.xy * aRect.zw, aUnit.z * height);
  vColor = vec4(aColorHeight.rgb, 1.0);
  vUnit = aUnit;
  vFace = float(gl_VertexID / 6);
  if(uMode < .5){
    vec2 p = (world.xy - uCenter) * uZoom;
    gl_Position = vec4(p.x * 2.0 / uViewport.x, -p.y * 2.0 / uViewport.y, aUnit.z * .001, 1.0);
  } else {
    vec3 p = vec3((world.xy - uCenter) / 420.0, world.z / 170.0);
    float cy=cos(uOrbit.x), sy=sin(uOrbit.x), cp=cos(uOrbit.y), sp=sin(uOrbit.y);
    p = vec3(cy*p.x-sy*p.y, sy*p.x+cy*p.y, p.z);
    // Positive pitch places the camera above the ground plane. The previous
    // signs put the eye below it, making every useful orbit an underside view.
    p = vec3(p.x, cp*p.y+sp*p.z, -sp*p.y+cp*p.z);
    float depth = max(.5, uDistance - p.y);
    float aspect = uViewport.x / uViewport.y;
    gl_Position = vec4(p.x/(depth*aspect)*2.7, (p.z-.35)/depth*2.7, (depth-1.0)/10.0, 1.0);
  }
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec3 vUnit;
in float vFace;
uniform float uMode;
uniform float uAlpha;
out vec4 outColor;
void main(){
  if(uMode < .5 && vFace > .5) discard;
  vec2 face = vFace < .5 || vFace > 4.5 ? vUnit.xy : vFace < 2.5 ? vUnit.xz : vUnit.yz;
  float edge = min(min(face.x, 1.0-face.x), min(face.y, 1.0-face.y));
  float border = smoothstep(0.0, fwidth(edge)*1.35 + .009, edge);
  vec3 base = vec3(.11);
  vec3 stroke = mix(vColor.rgb, vec3(1.0), .07);
  outColor = vec4(mix(stroke, base, border), uAlpha);
}`;

function shader(gl, type, source) {
  const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
  return value;
}

export class LandscapeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.program = gl.createProgram();
    gl.attachShader(this.program, shader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(this.program, shader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const vertices = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer();
    this.camera = { x: 500, y: 350, zoom: 1, yaw: -.1, pitch: .78, distance: 3.5 };
    this.mode = '2d'; this.count = 0;
    this.resize();
  }

  setData(items) {
    this.items = items;
    const packed = new Float32Array(items.length * 8);
    for (let i=0;i<items.length;i++) {
      const item=items[i], o=i*8;
      packed.set([item.x,item.y,item.w,item.h,item.color[0],item.color[1],item.color[2],item.height],o);
    }
    const gl=this.gl; gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.instances); gl.bufferData(gl.ARRAY_BUFFER,packed,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.FLOAT,false,32,0); gl.vertexAttribDivisor(1,1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,4,gl.FLOAT,false,32,16); gl.vertexAttribDivisor(2,1);
    this.count=items.length;
  }

  resize() {
    const dpr=Math.min(devicePixelRatio||1,2), w=Math.max(1,Math.floor(this.canvas.clientWidth*dpr)), h=Math.max(1,Math.floor(this.canvas.clientHeight*dpr));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    this.dpr=dpr; this.gl.viewport(0,0,w,h);
  }

  render(alpha=1) {
    const gl=this.gl; this.resize();
    gl.clearColor(.11,.11,.11,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    const u=n=>gl.getUniformLocation(this.program,n);
    gl.uniform2f(u('uCenter'),this.camera.x,this.camera.y);
    gl.uniform2f(u('uViewport'),this.canvas.width/this.dpr,this.canvas.height/this.dpr);
    gl.uniform1f(u('uZoom'),this.camera.zoom);
    gl.uniform1f(u('uMode'),this.mode==='3d'?1:0);
    gl.uniform2f(u('uOrbit'),this.camera.yaw,this.camera.pitch);
    gl.uniform1f(u('uDistance'),this.camera.distance);
    gl.uniform1f(u('uAlpha'),alpha);
    gl.drawArraysInstanced(gl.TRIANGLES,0,36,this.count);
  }

  screenRect(item) {
    if(this.mode==='2d') return { x:(item.x-this.camera.x)*this.camera.zoom+this.canvas.clientWidth/2, y:(item.y-this.camera.y)*this.camera.zoom+this.canvas.clientHeight/2, w:item.w*this.camera.zoom, h:item.h*this.camera.zoom };
    const corners=[[item.x,item.y,item.height],[item.x+item.w,item.y,item.height],[item.x,item.y+item.h,item.height],[item.x+item.w,item.y+item.h,item.height]].map(p=>this.project(p));
    const xs=corners.map(p=>p.x), ys=corners.map(p=>p.y);
    return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
  }

  project([x,y,z=0]) {
    let px=(x-this.camera.x)/420, py=(y-this.camera.y)/420, pz=z/170;
    const cy=Math.cos(this.camera.yaw),sy=Math.sin(this.camera.yaw),cp=Math.cos(this.camera.pitch),sp=Math.sin(this.camera.pitch);
    [px,py]=[cy*px-sy*py,sy*px+cy*py]; [py,pz]=[cp*py+sp*pz,-sp*py+cp*pz];
    const depth=Math.max(.5,this.camera.distance-py), aspect=this.canvas.clientWidth/this.canvas.clientHeight;
    return {x:this.canvas.clientWidth/2+(px/(depth*aspect)*2.7)*this.canvas.clientWidth/2,y:this.canvas.clientHeight/2-((pz-.35)/depth*2.7)*this.canvas.clientHeight/2,depth};
  }

  worldAt(clientX,clientY) {
    return {x:this.camera.x+(clientX-this.canvas.clientWidth/2)/this.camera.zoom,y:this.camera.y+(clientY-this.canvas.clientHeight/2)/this.camera.zoom};
  }
}
