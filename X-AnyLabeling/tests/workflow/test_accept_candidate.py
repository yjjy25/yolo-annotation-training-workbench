import copy
import pytest
from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.project import digest, write_json, read_json
from .test_project import make_project


def candidate(project, name):
    image=project.root/'images'/name
    data=read_json(project.annotation(image))
    data['shapes'][0]['points'][0]=[7,8]
    proposal={'base_hash':digest(project.annotation(image)),'task':project.data['task'],'classes':project.data['classes'],'template':project.data.get('template'),'annotation':data}
    path=project.root/'proposals'/'latest'/(image.stem+'.json')
    write_json(path,proposal)
    return path


def test_accept_returns_editable_draft_and_repeat_preserves_manual_tweak(tmp_path):
    project=make_project(tmp_path);name=project.images[0].name;path=candidate(project,name)
    accepted=desktop.accept_candidate(project,name)
    assert accepted['annotation']['shapes'][0]['points'][0]==[7,8]
    assert accepted['annotation']['checked'] is False and accepted['proposal'] is None
    assert not path.exists() and path.with_suffix('.accepted.json').exists()
    annotation=copy.deepcopy(accepted['annotation']);annotation['shapes'][0]['points'][0]=[9,10]
    desktop.save_annotation(project,name,annotation,accepted['base_hash'],True)
    repeated=desktop.accept_candidate(project,name)
    assert repeated['annotation']['shapes'][0]['points'][0]==[9,10]
    assert repeated['annotation']['checked'] is True


def test_missing_candidate_reports_actionable_error(tmp_path):
    project=make_project(tmp_path)
    with pytest.raises(ValueError,match='重新生成候选'):
        desktop.accept_candidate(project,project.images[0].name)


def test_stale_candidate_never_overwrites_manual_annotation(tmp_path):
    project=make_project(tmp_path);name=project.images[0].name;path=candidate(project,name)
    label=desktop.load_annotation(project,name);annotation=label['annotation'];annotation['description']='human edited'
    desktop.save_annotation(project,name,annotation,label['base_hash'],True)
    before=digest(project.annotation(name))
    with pytest.raises(ValueError,match='已经变化'):
        desktop.accept_candidate(project,name)
    assert digest(project.annotation(name))==before and path.exists()
