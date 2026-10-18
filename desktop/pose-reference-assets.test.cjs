const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base=path.join(__dirname,'../X-AnyLabeling/anylabeling/resources/pose_examples');
const catalog=JSON.parse(fs.readFileSync(path.join(base,'dog24-examples.json'),'utf8'));
assert.equal(catalog.template_points.length,24);assert.equal(catalog.examples.length,2);
for(const sample of catalog.examples){
 assert.equal(path.basename(sample.photo),sample.photo);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(base,sample.photo))).digest('hex'),sample.photo_sha256);
 assert.equal(sample.annotation.shapes.length,24);
 assert.equal(sample.original_yolo_annotation.length,77);
 const seen=new Set();
 for(const [i,name] of catalog.template_points.entries()){
  const shape=sample.annotation.shapes.find(s=>s.label===name);assert.ok(shape);assert.ok(!seen.has(name));seen.add(name);
  const [x,y]=shape.points[0];assert.ok(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=sample.annotation.imageWidth&&y>=0&&y<=sample.annotation.imageHeight);
  assert.equal(shape.flags.teaching_reference,i>=20);
  if(i<20){
   const row=sample.original_yolo_annotation;assert.ok(row[7+i*3]>0);
   assert.ok(Math.abs(x-row[5+i*3]*sample.annotation.imageWidth)<1e-8);
   assert.ok(Math.abs(y-row[6+i*3]*sample.annotation.imageHeight)<1e-8);
  }else assert.equal(shape.source,'manual_teaching_location');
 }
}
console.log('Passed 2 photograph asset and original-coordinate consistency checks');
