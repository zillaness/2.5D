"""Minimal STEP (ISO-10303-21) B-rep reader — just enough topology to pull an
extruded solid's cross-section. No CAD kernel needed for prismatic parts."""
import re, sys, math

def load(path):
    txt = open(path).read()
    # Strip comments, join the DATA section into id -> raw record.
    txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)
    data = txt.split('DATA;', 1)[1].split('ENDSEC', 1)[0]
    recs = {}
    for m in re.finditer(r'#(\d+)\s*=\s*([A-Z_0-9]+)\s*\((.*?)\)\s*;', data, flags=re.S):
        recs[int(m.group(1))] = (m.group(2), m.group(3))
    return recs

def refs(s):
    return [int(x) for x in re.findall(r'#(\d+)', s)]

def floats(s):
    # top-level numeric list like ('name',(x,y,z)) -> pull the paren group of nums
    m = re.search(r'\(([-0-9.eE,\s]+)\)', s)
    return [float(x) for x in m.group(1).split(',')] if m else []

class Model:
    def __init__(self, recs):
        self.r = recs
        self._pt = {}
        self._dir = {}
    def point(self, i):
        if i not in self._pt:
            self._pt[i] = tuple(floats(self.r[i][1]))
        return self._pt[i]
    def direction(self, i):
        if i not in self._dir:
            self._dir[i] = tuple(floats(self.r[i][1]))
        return self._dir[i]
    def vertex_point(self, i):
        return self.point(refs(self.r[i][1])[0])
    def solids(self):
        return [i for i, (k, _) in self.r.items() if k == 'MANIFOLD_SOLID_BREP']
    def solid_faces(self, sid):
        shell = refs(self.r[sid][1])[0]           # CLOSED_SHELL
        return refs(self.r[shell][1])             # ADVANCED_FACE ids
    def face_normal(self, fid):
        # ADVANCED_FACE('',(bounds),surface,flag); surface PLANE -> AXIS2_PLACEMENT_3D
        r = refs(self.r[fid][1])
        surf = None
        for x in r:
            if self.r[x][0] == 'PLANE':
                surf = x; break
        if surf is None:
            return None
        a2p = refs(self.r[surf][1])[0]
        dirs = refs(self.r[a2p][1])               # origin, axis(z=normal), ref(x)
        # AXIS2_PLACEMENT_3D('',#origin,#axis,#ref)
        norm_id = None
        for x in dirs:
            if self.r[x][0] == 'DIRECTION':
                norm_id = x; break
        return self.direction(norm_id) if norm_id else None
    def face_outer_loop_points(self, fid):
        # first FACE_OUTER_BOUND -> EDGE_LOOP -> ordered vertices
        for b in refs(self.r[fid][1]):
            if self.r[b][0] in ('FACE_OUTER_BOUND', 'FACE_BOUND'):
                loop = refs(self.r[b][1])[0]
                if self.r[loop][0] != 'EDGE_LOOP':
                    continue
                pts = []
                for oe in refs(self.r[loop][1]):      # ORIENTED_EDGE
                    ec = None
                    for x in refs(self.r[oe][1]):
                        if self.r[x][0] == 'EDGE_CURVE':
                            ec = x; break
                    if ec is None:
                        continue
                    vs = [x for x in refs(self.r[ec][1]) if self.r[x][0] == 'VERTEX_POINT']
                    if vs:
                        pts.append(self.vertex_point(vs[0]))
                return pts
        return []
    def solid_points(self, sid):
        pts = []
        for f in self.solid_faces(sid):
            pts += self.face_outer_loop_points(f)
        return pts

def bbox(pts):
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]; zs=[p[2] for p in pts]
    return (min(xs),max(xs)),(min(ys),max(ys)),(min(zs),max(zs))

if __name__ == '__main__':
    m = Model(load(sys.argv[1]))
    sids = m.solids()
    print(f"{len(sids)} solids\n")
    rows = []
    for s in sids:
        pts = m.solid_points(s)
        if not pts: continue
        (x0,x1),(y0,y1),(z0,z1) = bbox(pts)
        dims = sorted([round(x1-x0,2), round(y1-y0,2), round(z1-z0,2)])
        rows.append((s, dims, (round(x0,1),round(x1,1)),(round(y0,1),round(y1,1)),(round(z0,1),round(z1,1)), len(m.solid_faces(s))))
    rows.sort(key=lambda r: -r[1][2])
    for s,dims,xr,yr,zr,nf in rows:
        print(f"#{s:5d} dims(sorted mm)={dims}  faces={nf:3d}  X{xr} Y{yr} Z{zr}")
