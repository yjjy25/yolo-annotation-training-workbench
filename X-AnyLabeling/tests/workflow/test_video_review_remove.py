from pathlib import Path
import pytest

from anylabeling.services.workflow.project import read_json, digest
from anylabeling.services.workflow.tracking import run
from anylabeling.services.workflow.video_workspace import queue_review, remove_drafts, accept_frame, frame_store, cache_path, seek_frame
from .test_tracking import setup


def test_removing_review_drafts_is_recoverable_and_does_not_touch_dataset(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    accepted=accept_frame(project,{'id':record['id'],'name':first})
    before=digest(project.annotation(accepted['name']))
    queued=queue_review(project,{'id':record['id']})['names']
    selected=queued[:3]
    result=remove_drafts(project,{'names':selected})
    manifest=read_json(project.root/'videos'/record['id']/'manifest.json')
    assert all(n not in manifest['review_frames'] for n in selected)
    assert all(f['name'] not in selected for f in manifest['frames'])
    store=frame_store(project)
    for name in selected:
        assert not (store.root/'images'/name).exists()
        assert (Path(result['recovery'])/'images'/name).is_file()
        assert not cache_path(project,record,int(Path(name).stem.rsplit('_',1)[1])).exists()
    assert digest(project.annotation(accepted['name']))==before
    assert project.counts()['total']==1


def test_invalid_or_confirmed_draft_batch_fails_before_moving_anything(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    queued=queue_review(project,{'id':record['id']})['names']
    accept_frame(project,{'id':record['id'],'name':first})
    with pytest.raises(ValueError):remove_drafts(project,{'names':[queued[1],first]})
    assert (frame_store(project).root/'images'/queued[1]).is_file()


def test_remove_all_drafts_then_reopen_source_without_reusing_deleted_predictions(tmp_path):
    project,_,record,first=setup(tmp_path)
    run(project,{'id':record['id'],'name':first},lambda _:None)
    names=queue_review(project,{'id':record['id']})['names']
    remove_drafts(project,{'names':names})
    manifest=read_json(project.root/'videos'/record['id']/'manifest.json')
    assert manifest['frames']==[] and manifest['review_frames']==[]
    result=seek_frame(project,{'id':record['id'],'frame':0})
    assert result['has_annotation'] is False
