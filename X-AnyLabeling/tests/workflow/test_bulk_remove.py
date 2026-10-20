import pytest
from anylabeling.services.workflow import desktop
from anylabeling.services.workflow.project import digest, read_json
from .test_project import make_project


def test_selected_removal_archives_labels_and_updates_splits(tmp_path):
    project = make_project(tmp_path)
    project.build_dataset()
    names = [p.name for p in project.images[:2]]
    hashes = {n: (digest(project.root/'images'/n), digest(project.annotation(n))) for n in names}
    result = desktop.remove_images(project, {'project_root':str(project.root),'names':names+[names[0]]})
    assert result['count'] == 2 and not result['failed']
    assert len(project.images) == 2
    for name, (image_hash, annotation_hash) in hashes.items():
        assert digest(project.root/'removed'/'images'/name) == image_hash
        assert digest(project.root/'removed'/'annotations'/project.annotation(name).name) == annotation_hash
    splits=read_json(project.root/'splits.json')['assignments']
    assert all(n.rsplit('.',1)[0] not in {k.rsplit('.',1)[0] for k in splits} for n in names)
    assert (project.root/'project.json').is_file()


def test_all_removes_entire_dataset_and_preserves_project(tmp_path):
    project = make_project(tmp_path)
    result = desktop.remove_images(project, {'project_root':str(project.root),'all':True,'expected_count':4})
    assert result['count'] == 4 and not result['failed'] and not project.images
    assert len(list((project.root/'removed'/'images').iterdir())) == 4
    assert project.data['classes'] == ['object']
    assert (project.root/'project.json').is_file()


@pytest.mark.parametrize('payload', [
    {'names':['0.png','../1.png']}, {'names':['0.png','absent.png']},
    {'names':'0.png'}, {'names':[None]}, {'all':True,'expected_count':3},
])
def test_invalid_batch_does_not_move_anything(tmp_path, payload):
    project = make_project(tmp_path)
    with pytest.raises(ValueError):
        desktop.remove_images(project, {'project_root':str(project.root),**payload})
    assert len(project.images) == 4
    assert not (project.root/'removed').exists()


def test_project_switch_rejected_before_removal(tmp_path):
    project = make_project(tmp_path)
    with pytest.raises(ValueError, match='项目已切换'):
        desktop.remove_images(project, {'project_root':str(tmp_path/'other'),'all':True,'expected_count':4})
    assert len(project.images) == 4


def test_partial_failure_reports_successful_and_failed_names(tmp_path, monkeypatch):
    project = make_project(tmp_path)
    original = desktop.remove_image
    def remove(project, name, purge=False):
        if name == '1.png':
            raise OSError('locked fixture')
        return original(project,name,purge)
    monkeypatch.setattr(desktop,'remove_image',remove)
    result=desktop.remove_images(project, {'project_root':str(project.root),'names':['0.png','1.png','2.png']})
    assert result['names'] == ['0.png','2.png']
    assert result['failed'] == [{'name':'1.png','error':'locked fixture'}]
    assert {p.name for p in project.images} == {'1.png','3.png'}
