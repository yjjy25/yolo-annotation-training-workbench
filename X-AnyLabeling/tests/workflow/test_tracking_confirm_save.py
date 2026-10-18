"""Explicit save confirms a video draft; later independent dataset edits are protected."""
import pytest

from anylabeling.services.workflow.desktop import load_annotation, save_annotation
from anylabeling.services.workflow.project import digest, read_json
from anylabeling.services.workflow.video_workspace import accept_frame
from .test_tracking import setup


def edit_draft(project, name, offset):
    value=load_annotation(project,name)
    for p in value['annotation']['shapes'][0]['points']:
        p[0]+=offset
    save_annotation(project,name,value['annotation'],value['base_hash'],False)


def test_explicit_save_updates_own_confirmed_frame_without_duplication(tmp_path):
    project,_,record,first=setup(tmp_path)
    args={'id':record['id'],'name':first,'update_confirmed':True}
    initial=accept_frame(project,args)
    edit_draft(project,first,2)
    result=accept_frame(project,args)
    assert result['updated'] is True and result['name']==initial['name']
    assert project.counts()=={'total':1,'checked':1,'draft':0}
    assert read_json(project.annotation(result['name']))['shapes'][0]['points'][0][0]==32
    assert accept_frame(project,args)['already'] is True


def test_explicit_save_does_not_overwrite_a_separately_edited_dataset_copy(tmp_path):
    project,_,record,first=setup(tmp_path)
    args={'id':record['id'],'name':first,'update_confirmed':True}
    result=accept_frame(project,args)
    formal=load_annotation(project,result['name'])
    formal['annotation']['shapes'][0]['points'][0][0]+=3
    save_annotation(project,result['name'],formal['annotation'],formal['base_hash'],True)
    before=digest(project.annotation(result['name']))
    edit_draft(project,first,2)
    with pytest.raises(ValueError,match='副本后来被单独修改'):
        accept_frame(project,args)
    assert digest(project.annotation(result['name']))==before
