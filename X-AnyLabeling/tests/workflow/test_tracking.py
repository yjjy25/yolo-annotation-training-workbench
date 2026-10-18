"""Video propagation: real codec/flow, failure boundaries, and safe persistence."""
import copy

import cv2
import numpy as np
import pytest

from anylabeling.services.workflow.desktop import save_annotation
from anylabeling.services.workflow.project import Project, digest, read_json
from anylabeling.services.workflow.video_workspace import frame_store, seek_frame, accept_frame

def label_path(project,name):
    return frame_store(project).annotation(name)

from anylabeling.services.workflow.tracking import create_session, run, seed_data, Propagator, TrackingLost, advance_session


def frame(index, cut=None):
    rng = np.random.default_rng(42 if cut is None or index < cut else 63)
    texture = rng.integers(20, 240, (60, 70, 3), dtype=np.uint8)
    image = np.full((160, 260, 3), 15 if cut is None or index < cut else 170, np.uint8)
    x = 30 + index if cut is None or index < cut else 140 + index - cut
    image[40:100, x:x + 70] = texture
    return image, x


def make_video(tmp_path, cut=None, total=25):
    path = tmp_path / '追踪测试.avi'
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 10, (260, 160))
    assert writer.isOpened()
    for index in range(total):
        writer.write(frame(index, cut)[0])
    writer.release()
    return path


def annotation(x=30, pose=False):
    shapes = [{"label": "object", "shape_type": "rectangle", "points": [[x,40],[x+70,40],[x+70,100],[x,100]], "group_id": 1 if pose else None, "flags": {"occluded": True}}]
    if pose:
        shapes += [{"label": name, "shape_type": "point", "points": [[x+offset,70]], "group_id": 1, "difficult": name=='hidden'} for name, offset in [('joint',20),('hidden',45)]]
    return {"shapes": shapes, "flags": {}}


def setup(tmp_path, cut=None, pose=False, total=25):
    source = make_video(tmp_path, cut, total)
    project = Project.create(tmp_path/'project', '追踪', 'pose' if pose else 'detect', ['object'], template={"points": ['joint','hidden','missing']} if pose else None)
    record = create_session(project, {"path": str(source), "interval": .2})
    first = record['frames'][0]['name']
    save_annotation(project, first, annotation(pose=pose), None, True)
    return project, source, record, first


def test_propagates_coordinates_and_drafts_without_touching_source(tmp_path):
    project, source, record, first = setup(tmp_path)
    source_hash, seed_hash = digest(source), digest(label_path(project,first))
    result = run(project, {"id": record['id'], "name": first}, lambda _: None)
    assert result['status'] == 'completed', result
    current = read_json(project.root/'videos'/record['id']/'manifest.json')
    assert [f['frame'] for f in current['frames']] == list(range(0,25,2))
    assert digest(source) == source_hash
    assert digest(label_path(project,first)) == seed_hash
    for f in current['frames'][1:]:
        data = read_json(label_path(project,f['name']))
        assert data['checked'] is False and data['tracking']['generated'] is True
        assert abs(data['shapes'][0]['points'][0][0] - (30+f['frame'])) < 2
        assert data['shapes'][0]['flags']['occluded'] is True
    assert project.counts()=={'total':0,'checked':0,'draft':0}
    assert frame_store(project).counts()['draft']==13


def test_pose_local_landmarks_occlusion_and_unknown_points_survive(tmp_path):
    project, _, record, first = setup(tmp_path, pose=True)
    result = run(project, {"id": record['id'], "name": first}, lambda _: None)
    assert result['status'] == 'completed', result
    last = read_json(label_path(project,result['name']))
    assert len(last['shapes']) == 3  # Never invent skipped keypoints.
    assert last['shapes'][2]['difficult'] is True
    assert all(s['group_id'] == 1 for s in last['shapes'])
    assert abs(last['shapes'][1]['points'][0][0]-74) < 2


def test_scene_cut_pauses_on_blank_problem_frame_and_can_resume(tmp_path):
    project, _, record, first = setup(tmp_path, cut=12)
    result = run(project, {"id": record['id'], "name": first}, lambda _: None)
    assert result['status'] == 'paused' and result['frame'] == 12, result
    assert not label_path(project,result['name']).exists()
    assert not any(f['frame'] > 12 for f in read_json(project.root/'videos'/record['id']/'manifest.json')['frames'])
    save_annotation(project, result['name'], annotation(140), None, True)
    resumed = run(project, {"id": record['id'], "name": result['name']}, lambda _: None)
    assert resumed['status'] == 'completed', resumed
    assert abs(read_json(label_path(project,resumed['name']))['shapes'][0]['points'][0][0]-152) < 2


def test_existing_future_annotation_is_preserved(tmp_path):
    project, _, record, first = setup(tmp_path)
    done = run(project, {"id": record['id'], "name": first}, lambda _: None)
    second=record['id']+'_000000002.jpg'
    data=read_json(label_path(project,second))
    save_annotation(project,second,data,digest(label_path(project,second)),False)
    labels={p.name:digest(p) for p in (frame_store(project).root/'annotations').glob('*.json')}
    result=run(project,{"id":record['id'],"name":first},lambda _:None)
    assert result['status']=='paused' and result['frame']==2
    assert digest(label_path(project,second))==labels[label_path(project,second).name]
    assert seed_data(project,read_json(project.root/'videos'/record['id']/'manifest.json'),second)[0]['shapes']


def test_cancel_keeps_results_and_does_not_generate_future_labels(tmp_path):
    project, _, record, first = setup(tmp_path)
    updates=[]
    result = run(project, {"id": record['id'], "name": first}, updates.append,
                 lambda: bool(updates and updates[-1].get('generated',0)>=5))
    assert result['status'] == 'stopped'
    assert project.counts()['total']==0
    assert frame_store(project).counts()=={'total':6,'checked':0,'draft':6}


def test_untextured_missing_or_large_motion_stops():
    image, _ = frame(0)
    tracker = Propagator(image, annotation())
    with pytest.raises(TrackingLost):
        tracker.step(np.full_like(image,15))
    tracker = Propagator(image, annotation())
    jumped = np.full_like(image,15);jumped[40:100,130:200]=image[40:100,30:100]
    with pytest.raises(TrackingLost):
        tracker.step(jumped)
    with pytest.raises(TrackingLost, match='纹理'):
        Propagator(np.full_like(image,15), annotation())


def test_invalid_seed_source_and_profile_fail_before_writing(tmp_path):
    project, source, record, first = setup(tmp_path)
    with pytest.raises(ValueError, match='灵敏度'):
        create_session(project, {'path':str(source), 'profile':'unknown'})
    with pytest.raises(ValueError, match='起始标注'):
        run(project, {'id':record['id'], 'name':first, 'seed_hash':'changed'}, lambda _:None)
    source.write_bytes(b'changed')
    with pytest.raises(ValueError, match='原视频'):
        run(project, {'id':record['id'], 'name':first}, lambda _:None)
    assert project.counts()['total']==0
    assert frame_store(project).counts()['total']==1


def test_final_non_sampled_frame_is_saved(tmp_path):
    project, _, record, first = setup(tmp_path,total=24)
    result=run(project, {'id':record['id'], 'name':first}, lambda _:None)
    assert result['status']=='completed'
    assert read_json(label_path(project,result['name']))['tracking']['frame']==23


def test_failure_between_sampled_frames_is_still_detected(tmp_path):
    project, _, record, first = setup(tmp_path,cut=11)
    result=run(project, {'id':record['id'], 'name':first}, lambda _:None)
    assert result['status']=='paused' and result['frame']==11
    assert not label_path(project,result['name']).exists()


def test_forward_seek_adds_no_labels_and_can_seek_past_missing_target(tmp_path):
    project, _, record, first=setup(tmp_path)
    second=advance_session(project, {'id':record['id'], 'name':first})
    assert second['name'].endswith('000000010.jpg')
    assert not label_path(project,second['name']).exists()
    third=advance_session(project, {'id':record['id'], 'name':second['name']})
    assert third['name'].endswith('000000020.jpg')
    assert project.counts()['total']==0
    assert frame_store(project).counts()=={'total':3,'checked':0,'draft':1}
    fourth=advance_session(project, {'id':record['id'], 'name':third['name']})
    assert fourth['name'].endswith('000000024.jpg')
    with pytest.raises(ValueError, match='结尾'):
        advance_session(project, {'id':record['id'], 'name':fourth['name']})


@pytest.mark.parametrize('kind', ['polygon','rotation','circle'])
def test_other_geometry_moves_without_losing_flags(kind):
    image,_=frame(0);data=annotation();data['shapes'][0]['shape_type']=kind
    if kind=='circle':
        data['shapes'][0]['points']=[[65,70],[30,25],[65,95]]
    tracker=Propagator(image,data)
    updated=tracker.step(frame(1)[0])
    old,new=data['shapes'][0],updated['shapes'][0]
    assert new['shape_type']==kind and new['flags']==old['flags']
    assert abs(new['points'][0][0]-old['points'][0][0]-1)<.5
    if kind=='circle':
        assert abs(new['points'][1][0]-30)<.5  # Radii are not coordinates.


def test_multiple_independent_instances_and_one_lost_stops_all():
    image,_=frame(0);second=np.random.default_rng(77).integers(20,240,(45,45,3),dtype=np.uint8)
    image[105:150,180:225]=second
    data=annotation();other=copy.deepcopy(data['shapes'][0]);other['points']=[[180,105],[225,105],[225,150],[180,150]]
    data['shapes'].append(other)
    tracker=Propagator(image,data)
    next_frame,_=frame(1);next_frame[104:149,179:224]=second
    result=tracker.step(next_frame)
    assert abs(result['shapes'][0]['points'][0][0]-31)<.5
    assert abs(result['shapes'][1]['points'][0][0]-179)<.5
    next_frame,_=frame(2)
    with pytest.raises(TrackingLost):
        tracker.step(next_frame)


def test_long_clip_pauses_at_checkpoint_before_automatic_drift(tmp_path):
    project, source, record, first=setup(tmp_path)
    writer=cv2.VideoWriter(str(source),cv2.VideoWriter_fourcc(*'MJPG'),10,(260,160))
    for _ in range(310):
        writer.write(frame(0)[0])
    writer.release()
    manifest=project.root/'videos'/record['id']/'manifest.json'
    record.update(source_bytes=source.stat().st_size,source_mtime_ns=source.stat().st_mtime_ns,source_frames=310)
    record['tracking']['interval']=7
    from anylabeling.services.workflow.project import write_json
    write_json(manifest,record)
    result=run(project, {'id':record['id'], 'name':first}, lambda _:None)
    assert result['status']=='paused' and result['frame']==300
    assert result['generated']==4
    assert not label_path(project,result['name']).exists()  # Unsampled checkpoint needs manual labeling.


def test_unknown_frame_count_still_saves_final_frame(tmp_path):
    project, _, record, first=setup(tmp_path,total=24)
    from anylabeling.services.workflow.project import write_json
    record['source_frames']=0
    write_json(project.root/'videos'/record['id']/'manifest.json',record)
    result=run(project, {'id':record['id'], 'name':first}, lambda _:None)
    assert result['status']=='completed'
    assert read_json(label_path(project,result['name']))['tracking']['frame']==23


def test_play_mode_delivers_every_raw_frame_without_changing_sample_interval(tmp_path):
    project, _, record, first=setup(tmp_path,cut=12)
    frames=[]
    def preview(image,index,data):
        frames.append(index)
        assert data['checked'] is False and image.shape[:2]==(160,260)
        return True
    result=run(project,{'id':record['id'],'name':first,'mode':'play'},lambda _:None,preview=preview)
    assert result['status']=='paused' and result['frame']==12
    assert frames==list(range(1,12))
    assert project.counts()['total']==0
    assert frame_store(project).counts()=={'total':7,'checked':0,'draft':6}


def test_manual_stop_in_preview_saves_current_unsampled_frame(tmp_path):
    project, _, record, first=setup(tmp_path)
    before=digest(label_path(project,first))
    result=run(project,{'id':record['id'],'name':first,'mode':'play'},lambda _:None,
               preview=lambda image,index,data:index<3)
    assert result['status']=='stopped' and result['frame']==3
    assert read_json(label_path(project,result['name']))['tracking']['frame']==3
    assert digest(label_path(project,first))==before


def test_direct_mode_does_not_request_preview(tmp_path):
    project, _, record, first=setup(tmp_path)
    def unexpected(*args):
        raise AssertionError('direct mode must not stream previews')
    assert run(project,{'id':record['id'],'name':first,'mode':'direct'},lambda _:None,preview=unexpected)['status']=='completed'


def test_preview_connection_failure_pauses_with_current_valid_frame(tmp_path):
    project, _, record, first=setup(tmp_path)
    def disconnected(*args):
        raise TrackingLost('预览未响应')
    result=run(project,{'id':record['id'],'name':first,'mode':'play'},lambda _:None,preview=disconnected)
    assert result['status']=='paused' and result['frame']==1
    assert label_path(project,result['name']).exists()
