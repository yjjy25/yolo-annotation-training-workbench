import copy
import cv2
import numpy as np
import pytest

from anylabeling.services.workflow.desktop import load_annotation, save_annotation
from anylabeling.services.workflow.project import digest, read_json
from anylabeling.services.workflow.tracking import run
from anylabeling.services.workflow.video_workspace import frame_store, seek_frame, accept_frame, queue_review
from .test_tracking import setup, label_path


def test_review_queue_is_persistent_and_excludes_unlabelled_and_accepted_frames(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    accepted=accept_frame(project,{'id':record['id'],'name':first})
    result=queue_review(project,{'id':record['id']})
    assert first not in result['names']
    assert result['count']>0
    manifest=read_json(project.root/'videos'/record['id']/'manifest.json')
    assert manifest['review_frames']==result['names']
    assert project.counts()=={'total':1,'checked':1,'draft':0}
    assert (project.root/'images'/accepted['name']).exists()
    assert all(read_json(label_path(project,n))['checked'] is False for n in result['names'])


def test_video_drafts_never_enter_dataset_until_explicit_confirmation(tmp_path):
    project,_,record,first=setup(tmp_path)
    result=run(project,{'id':record['id'],'name':first},lambda _:None)
    assert project.counts()=={'total':0,'checked':0,'draft':0}
    assert len(frame_store(project).images)==13
    accepted=accept_frame(project,{'id':record['id'],'name':result['name']})
    assert accepted['count']==1
    assert project.counts()=={'total':1,'checked':1,'draft':0}
    assert read_json(project.annotation(accepted['name']))['tracking']['confirmed_from']==result['name']
    assert label_path(project,result['name']).exists()
    assert accept_frame(project,{'id':record['id'],'name':result['name']})['already'] is True
    assert project.counts()['total']==1


def test_seek_unsampled_frame_restores_its_real_prediction_and_image(tmp_path):
    project,source,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    selected=seek_frame(project,{'id':record['id'],'frame':5})
    loaded=load_annotation(project,selected['name'])
    assert abs(loaded['annotation']['shapes'][0]['points'][0][0]-35)<2
    assert loaded['annotation']['checked'] is False
    capture=cv2.VideoCapture(str(source));capture.set(cv2.CAP_PROP_POS_FRAMES,5);ok,expected=capture.read();capture.release()
    actual=cv2.imdecode(np.fromfile(frame_store(project).root/'images'/selected['name'],dtype=np.uint8),cv2.IMREAD_COLOR)
    assert ok and np.abs(actual.astype(float)-expected).mean()<5
    assert project.counts()['total']==0


def test_corrected_frame_is_persistent_and_is_the_new_tracking_seed(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    selected=seek_frame(project,{'id':record['id'],'frame':5})
    loaded=load_annotation(project,selected['name']);data=loaded['annotation']
    data['shapes'][0]['points'][0][0]+=.8
    save_annotation(project,selected['name'],data,loaded['base_hash'],True)
    corrected=digest(label_path(project,selected['name']))
    seek_frame(project,{'id':record['id'],'frame':3})
    seek_frame(project,{'id':record['id'],'frame':5})
    assert digest(label_path(project,selected['name']))==corrected
    result=run(project,{'id':record['id'],'name':selected['name']},lambda _:None)
    assert result['status']=='completed'
    next_frame=seek_frame(project,{'id':record['id'],'frame':6})
    assert read_json(label_path(project,next_frame['name']))['tracking']['seed']==selected['name']
    assert digest(label_path(project,selected['name']))==corrected
    assert project.counts()['total']==0


def test_existing_manual_keyframe_stops_forward_recomputation(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    keyframe=seek_frame(project,{'id':record['id'],'frame':7})
    loaded=load_annotation(project,keyframe['name'])
    save_annotation(project,keyframe['name'],loaded['annotation'],loaded['base_hash'],False)
    before=digest(label_path(project,keyframe['name']))
    result=run(project,{'id':record['id'],'name':first},lambda _:None)
    assert result['status']=='paused' and result['frame']==7
    assert digest(label_path(project,keyframe['name']))==before


def test_dataset_copy_is_independent_from_later_draft_edits(tmp_path):
    project,_,record,first=setup(tmp_path)
    accepted=accept_frame(project,{'id':record['id'],'name':first})
    before=digest(project.annotation(accepted['name']))
    loaded=load_annotation(project,first);loaded['annotation']['shapes'][0]['points'][0][0]+=1
    save_annotation(project,first,loaded['annotation'],loaded['base_hash'],False)
    assert digest(project.annotation(accepted['name']))==before
    with pytest.raises(ValueError,match='已加入数据集'):
        accept_frame(project,{'id':record['id'],'name':first})


def test_untracked_position_has_no_guessed_label_and_invalid_seek_rejected(tmp_path):
    project,_,record,first=setup(tmp_path)
    selected=seek_frame(project,{'id':record['id'],'frame':8})
    assert load_annotation(project,selected['name'])['annotation'] is None
    with pytest.raises(ValueError,match='标注并保存'):
        accept_frame(project,{'id':record['id'],'name':selected['name']})
    for value in [-1,25,1.5,'5']:
        with pytest.raises(ValueError,match='范围'):
            seek_frame(project,{'id':record['id'],'frame':value})


def test_auto_save_review_flag_does_not_publish_video_draft(tmp_path):
    project,_,record,first=setup(tmp_path,pose=True)
    data=load_annotation(project,first)
    saved=save_annotation(project,first,data['annotation'],data['base_hash'],True)
    assert saved['checked'] is False and project.counts()['total']==0
    assert load_annotation(project,first)['annotation']['shapes'][2]['difficult'] is True
