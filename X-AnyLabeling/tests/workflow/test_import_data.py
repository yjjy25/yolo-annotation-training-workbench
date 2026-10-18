from pathlib import Path
from PIL import Image
import pytest

from anylabeling.services.workflow.desktop import create_project
from anylabeling.services.workflow.import_data import import_images
from anylabeling.services.workflow.project import digest, read_json, write_json


@pytest.mark.parametrize('task',['detect','pose','segment','obb','classify'])
def test_empty_project_needs_no_source(tmp_path,task):
    project=create_project({'root':str(tmp_path/'project'),'name':'空项目','task':task,'classes':['object'],'preset':'dog'})
    assert project.counts()=={'total':0,'checked':0,'draft':0}
    assert (project.root/'project.json').exists()


def image(path,color='red'):
    path.parent.mkdir(parents=True,exist_ok=True)
    Image.new('RGB',(64,48),color).save(path)
    return path


def project(tmp_path):
    return create_project({'root':str(tmp_path/'project'),'name':'空项目','task':'detect','classes':['object']})


def test_import_can_append_skip_duplicate_and_rename_conflicts(tmp_path):
    target=project(tmp_path);source=tmp_path/'source';first=image(source/'cat.jpg')
    before=digest(first)
    assert import_images(target,{'path':str(source)})['count']==1
    assert import_images(target,{'paths':[str(first)]})['skipped']==1
    label=target.annotation('cat.jpg');write_json(label,{'checked':True,'shapes':[]})
    label_before=digest(label)
    second=image(tmp_path/'other'/'cat.png','blue')
    result=import_images(target,{'paths':[str(second)]})
    assert result['count']==1 and result['renamed']==1
    assert (target.root/'images'/'cat_2.png').exists()
    assert digest(label)==label_before and digest(first)==before
    assert not list((target.root/'imports').glob('*/staged/*'))


def test_annotations_import_as_drafts_with_correct_name_and_dimensions(tmp_path):
    target=project(tmp_path);source=image(tmp_path/'source'/'one.jpg')
    write_json(source.with_suffix('.json'),{'checked':True,'imageWidth':1,'imageHeight':1,'shapes':[{'shape_type':'rectangle','label':'object','points':[[2,2],[20,2],[20,20],[2,20]],'flags':{'occluded':True}}]})
    result=import_images(target,{'path':str(source.parent)})
    data=read_json(target.annotation(result['first']))
    assert data['checked'] is False and data['imageWidth']==64 and data['imageHeight']==48
    assert data['shapes'][0]['flags']['occluded'] is True
    assert read_json(source.with_suffix('.json'))['checked'] is True


def test_broken_image_or_invalid_label_aborts_whole_batch(tmp_path):
    target=project(tmp_path);source=image(tmp_path/'source'/'a.jpg')
    (source.parent/'z.jpg').write_bytes(b'broken')
    with pytest.raises(ValueError,match='无法解码'):
        import_images(target,{'path':str(source.parent)})
    assert target.images==[]
    with pytest.raises(ValueError,match='之外'):
        import_images(target,{'path':str(target.root)})


def test_reject_invalid_annotation_without_replacing_prior_data(tmp_path):
    target=project(tmp_path);source=image(tmp_path/'source'/'one.jpg')
    write_json(source.with_suffix('.json'),{'shapes':[{'label':'unknown','shape_type':'rectangle','points':[[2,2],[20,2],[20,20],[2,20]]}]})
    with pytest.raises(ValueError,match='未知标签'):
        import_images(target,{'paths':[str(source)]})
    assert target.images==[]


def test_duplicate_with_uppercase_extension_is_skipped_on_all_platforms(tmp_path):
    target=project(tmp_path);source=image(tmp_path/'source'/'one.JPG')
    assert import_images(target,{'paths':[str(source)]})['count']==1
    assert import_images(target,{'paths':[str(source)]})['skipped']==1


def test_publish_failure_rolls_back_only_new_files(tmp_path,monkeypatch):
    import anylabeling.services.workflow.import_data as module
    target=project(tmp_path);old=image(target.root/'images'/'old.jpg','green');before=digest(old)
    first=image(tmp_path/'source'/'a.jpg');image(first.parent/'b.jpg','blue')
    original=module.shutil.copyfileobj;calls=0
    def fail_second(source,destination,*args,**kwargs):
        nonlocal calls
        calls+=1
        if calls==2:raise OSError('disk full')
        return original(source,destination,*args,**kwargs)
    monkeypatch.setattr(module.shutil,'copyfileobj',fail_second)
    with pytest.raises(OSError,match='disk full'):
        import_images(target,{'path':str(first.parent)})
    assert [p.name for p in target.images]==['old.jpg'] and digest(old)==before
