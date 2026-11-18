# -*- coding: utf-8 -*-
"""Rhino 8 worker for one isolated render-cache job. Source files are never modified."""
import Rhino
import System
import io
import json
import math
import os
import traceback

job = os.environ['RENDER_WORKBENCH_JOB']
source_path = os.path.join(job, 'source.3dm')
result_path = os.path.join(job, 'mesh.3dm')
report_path = os.path.join(job, 'result.json')
progress_path = os.path.join(job, 'progress.json')

def progress(stage, completed=0, total=0):
    with io.open(progress_path, 'w', encoding='utf-8') as stream:
        stream.write(unicode(json.dumps({'stage':stage, 'completed':completed, 'total':total})))

def emit(data):
    with io.open(report_path, 'w', encoding='utf-8') as stream:
        stream.write(unicode(json.dumps(data, ensure_ascii=True)))

def convert():
    src = Rhino.FileIO.File3dm.Read(source_path)
    if src is None:
        raise ValueError(u'Rhino could not read the 3DM')
    dst = Rhino.FileIO.File3dm()
    dst.Settings.ModelUnitSystem = src.Settings.ModelUnitSystem
    mp = Rhino.Geometry.MeshingParameters()
    unit = src.Settings.ModelUnitSystem
    ratio = Rhino.RhinoMath.UnitScale(Rhino.UnitSystem.Millimeters, unit)
    if not (0 < ratio < float('inf')):
        ratio = 1.
    mp.Tolerance = .025 * ratio
    mp.MinimumEdgeLength = .08 * ratio
    mp.GridAngle = math.radians(6)
    mp.RefineAngle = math.radians(6)
    mp.SimplePlanes = True
    mp.RefineGrid = True
    mp.JaggedSeams = False

    materials = {}
    for mat in src.Materials:
        index = dst.Materials.Count
        dst.Materials.Add(Rhino.DocObjects.Material(mat))
        materials[mat.MaterialIndex] = index
    layers = dict((l.Index,l) for l in src.AllLayers)
    layer_ids = dict((l.Id,l) for l in layers.values())
    layer_map = {}
    for i,l in layers.items():
        # Preserve display color; resolve layer material into each mesh's attributes.
        layer_map[i] = dst.AllLayers.AddLayer('Layer_%d' % i, l.Color)
    objects = dict((o.Attributes.ObjectId,o) for o in src.Objects)
    definitions = dict((d.Id,d) for d in src.AllInstanceDefinitions)
    parts = [0]
    triangles = [0]
    failures = []
    geometry_bounds = Rhino.Geometry.BoundingBox.Empty
    mesh_bounds = Rhino.Geometry.BoundingBox.Empty

    def visible(l):
        seen = set()
        while l:
            if not l.IsVisible:
                return False
            if l.Id in seen:
                break
            seen.add(l.Id)
            l = layer_ids.get(l.ParentLayerId)
        return True

    def object_visible(a):
        return (a.Visible and a.Mode != Rhino.DocObjects.ObjectMode.Hidden
                and a.Space != Rhino.DocObjects.ActiveSpace.PageSpace
                and visible(layers.get(a.LayerIndex)))

    def visit(obj, xform, stack, parent_material, parent_color):
        g, a = obj.Geometry, obj.Attributes
        layer = layers.get(a.LayerIndex)
        if not object_visible(a):
            return
        name = a.Name or str(a.ObjectId)
        material_source = Rhino.DocObjects.ObjectMaterialSource
        color_source = Rhino.DocObjects.ObjectColorSource
        material_index = a.MaterialIndex if a.MaterialSource == material_source.MaterialFromObject else (
            parent_material if a.MaterialSource == material_source.MaterialFromParent else (layer.RenderMaterialIndex if layer else -1))
        color = a.ObjectColor if a.ColorSource == color_source.ColorFromObject else (
            parent_color if a.ColorSource == color_source.ColorFromParent and parent_color is not None else (layer.Color if layer else a.ObjectColor))
        if isinstance(g,Rhino.Geometry.InstanceReferenceGeometry):
            block = definitions.get(g.ParentIdefId)
            if block is None or block.Id in stack or len(stack) >= 64:
                failures.append(name + u': missing or recursive block')
                return
            for oid in block.GetObjectIds():
                if oid not in objects:
                    failures.append(name + u': missing block component')
                else:
                    visit(objects[oid], xform * g.Xform, stack + [block.Id], material_index, color)
            return
        if isinstance(g,(Rhino.Geometry.Curve,Rhino.Geometry.AnnotationBase,Rhino.Geometry.Point,
                         Rhino.Geometry.PointCloud,Rhino.Geometry.TextDot,Rhino.Geometry.Light)):
            return
        try:
            world = g.Duplicate()
            if not xform.IsIdentity and not world.Transform(xform):
                raise ValueError('geometry transform failed')
            if isinstance(world,Rhino.Geometry.Mesh):
                mesh = world
            elif isinstance(world,Rhino.Geometry.SubD):
                mesh = Rhino.Geometry.Mesh.CreateFromSubD(world,4)
            else:
                if isinstance(world,Rhino.Geometry.Extrusion):
                    world = world.ToBrep(True)
                elif isinstance(world,Rhino.Geometry.Surface):
                    world = world.ToBrep()
                if not isinstance(world,Rhino.Geometry.Brep):
                    raise ValueError('unsupported geometry: ' + str(g.GetType().Name))
                chunks = Rhino.Geometry.Mesh.CreateFromBrep(world,mp)
                if not chunks or any(m is None or m.Faces.Count == 0 for m in chunks):
                    raise ValueError('one or more surfaces did not mesh')
                mesh = Rhino.Geometry.Mesh()
                for m in chunks:
                    mesh.Append(m)
            if mesh is None or not mesh.IsValid or mesh.Faces.Count < 1:
                raise ValueError('invalid mesh')
            mesh.Faces.ConvertQuadsToTriangles()
            if mesh.Normals.Count != mesh.Vertices.Count:
                mesh.Normals.ComputeNormals()
            mesh.Compact()
            attr = Rhino.DocObjects.ObjectAttributes()
            attr.Name = a.Name or name
            if a.LayerIndex in layer_map:
                attr.LayerIndex = layer_map[a.LayerIndex]
            attr.ColorSource = color_source.ColorFromObject
            attr.ObjectColor = color
            if material_index in materials:
                attr.MaterialSource = material_source.MaterialFromObject
                attr.MaterialIndex = materials[material_index]
            if dst.Objects.AddMesh(mesh,attr) == System.Guid.Empty:
                raise ValueError('could not store mesh')
            parts[0] += 1
            triangles[0] += mesh.Faces.Count
            geometry_bounds.Union(world.GetBoundingBox(True))
            mesh_bounds.Union(mesh.GetBoundingBox(True))
        except Exception as e:
            failures.append(name + u': ' + unicode(e))

    visible_objects = [
        obj for obj in src.Objects
        if not obj.Attributes.IsInstanceDefinitionObject and object_visible(obj.Attributes)
    ]
    total = len(visible_objects)
    progress('meshing', 0, total)
    for index, obj in enumerate(visible_objects):
        visit(obj,Rhino.Geometry.Transform.Identity,[],-1,None)
        if index % 4 == 0 or index + 1 == total:
            progress('meshing', index + 1, total)
    if failures:
        return {'error':u'; '.join(failures[:4]), 'failed':len(failures)}
    if not parts[0]:
        return {'error':'No visible renderable objects'}
    progress('writing')
    if not dst.Write(result_path,Rhino.FileIO.File3dmWriteOptions()):
        return {'error':'Could not write mesh cache'}
    def xyz(v):
        return [v.X,v.Y,v.Z]
    return {'parts':parts[0], 'triangles':triangles[0], 'unit':str(unit),
            'sourceDimensions':xyz(geometry_bounds.Max-geometry_bounds.Min),
            'meshDimensions':xyz(mesh_bounds.Max-mesh_bounds.Min)}

try:
    emit(convert())
except:
    emit({'error':traceback.format_exc()})
