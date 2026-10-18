"""Geometry accuracy during resize, aspect changes, truncation and re-entry."""
import copy

import cv2
import numpy as np
import pytest

from anylabeling.services.workflow.tracking import Propagator, TrackingLost
from .test_tracking import annotation, frame


def render(base, sx=1., sy=1., dx=0., dy=0.):
    # Resize about the annotated object's original upper-left corner (30,40).
    matrix=np.array([[sx,0,30*(1-sx)+dx],[0,sy,40*(1-sy)+dy]],np.float32)
    return cv2.warpAffine(base,matrix,(260,160),borderValue=(15,15,15))


@pytest.mark.parametrize('anisotropic', [False, True])
def test_box_follows_uniform_and_independent_width_height_changes(anisotropic):
    base,_=frame(0)
    tracker=Propagator(base,annotation())
    for index in range(1,21):
        sx=1+.025*index
        sy=1-.008*index if anisotropic else 1+.018*index
        result=tracker.step(render(base,sx,sy,dx=index*.4))
        points=np.asarray(result['shapes'][0]['points'])
        assert abs(np.ptp(points[:,0])-70*sx)<6
        assert abs(np.ptp(points[:,1])-60*sy)<6
        assert result['checked'] is False


@pytest.mark.parametrize('direction', ['left','right','top','bottom'])
def test_partial_exit_and_reentry_keeps_full_model_size(direction):
    base,_=frame(0)
    tracker=Propagator(base,annotation())
    distance={'left':-57,'right':185,'top':-63,'bottom':83}[direction]
    maximum=abs(distance)
    steps=round(maximum/3)
    offsets=np.r_[np.linspace(0,distance,steps+1)[1:],np.linspace(distance,0,steps+1)[1:]]
    saw_truncated=False
    for offset in offsets:
        dx=offset if direction in ('left','right') else 0
        dy=offset if direction in ('top','bottom') else 0
        result=tracker.step(render(base,dx=dx,dy=dy))
        box=result['shapes'][0]
        points=np.asarray(box['points'])
        assert (points>=0).all() and (points[:,0]<=260).all() and (points[:,1]<=160).all()
        expected=np.array([[max(0,30+dx),max(0,40+dy)],[min(260,100+dx),min(160,100+dy)]])
        assert np.max(np.abs(np.array([points.min(axis=0),points.max(axis=0)])-expected))<5
        saw_truncated |= box.get('tracking_truncated',False)
    assert saw_truncated
    assert np.max(np.abs(np.ptp(points,axis=0)-[70,60]))<5


def test_fully_lost_target_still_pauses():
    base,_=frame(0)
    tracker=Propagator(base,annotation())
    with pytest.raises(TrackingLost):
        for dx in range(-3,-103,-3):
            tracker.step(render(base,dx=dx))


def test_out_of_frame_pose_point_is_omitted_and_reentry_is_uncertain():
    base,_=frame(0)
    data=annotation(pose=True)
    tracker=Propagator(base,data)
    for dx in range(-3,-58,-3):
        result=tracker.step(render(base,dx=dx))
    assert all(s['label']!='joint' for s in result['shapes'])
    for dx in range(-54,1,3):
        result=tracker.step(render(base,dx=dx))
    joint=next(s for s in result['shapes'] if s['label']=='joint')
    assert joint['difficult'] is True
    assert len(result['shapes'])==len(data['shapes'])


def test_failed_multi_object_frame_does_not_mutate_tracker_state():
    base,_=frame(0)
    texture=np.random.default_rng(7).integers(20,240,(40,40,3),dtype=np.uint8)
    base[110:150,180:220]=texture
    data=annotation()
    second=copy.deepcopy(data['shapes'][0])
    second['points']=[[180,110],[220,110],[220,150],[180,150]]
    data['shapes'].append(second)
    tracker=Propagator(base,data)
    broken=render(base,dx=1)
    broken[108:153,178:224]=15
    with pytest.raises(TrackingLost):
        tracker.step(broken)
    valid=render(base,dx=1)
    result=tracker.step(valid)
    assert abs(result['shapes'][0]['points'][0][0]-31)<1
