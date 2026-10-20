"""Roundtrips and refusal boundaries for recoverable deletion and project transfer."""
import json
from pathlib import Path
import zipfile
import pytest
from anylabeling.services.workflow.project import Project, write_json, read_json, digest
from anylabeling.services.workflow import recycle, project_transfer as transfer
from anylabeling.services.workflow.artifacts import archive


@pytest.fixture
def project(tmp_path):
    p=Project.create(tmp_path/'用户甲'/'项目','便携项目','detect',['cat'])
    for name in ['a','b']:
        (p.root/'images'/f'{name}.png').write_bytes(b'image-'+name.encode())
        write_json(p.annotation(name+'.png'),{'imagePath':str(p.root/'images'/f'{name}.png'),'checked':True,'shapes':[]})
    write_json(p.root/'splits.json',{'assignments':{'a.png':'train','b.png':'val'}})
    return p


def choices(p):
    return {'project_root':str(p.root),'targets':[{'key':i['key'],'signature':i['signature']} for i in recycle.inventory(p)]}


def test_batch_restore_preserves_image_label_split_hashes(project):
    before={x.relative_to(project.root).as_posix():digest(x) for folder in ['images','annotations'] for x in (project.root/folder).iterdir()}
    for name in ['a.png','b.png']:project.remove_image(name)
    assert len(recycle.inventory(project))==2 and not project.images
    assert recycle.restore(project,choices(project))['count']==2
    assert all(digest(project.root/name)==value for name,value in before.items())
    assert read_json(project.root/'splits.json')['assignments']=={'a.png':'train','b.png':'val'}
    assert not recycle.inventory(project)


def test_name_collision_does_not_overwrite_and_archive_generations_restore(project):
    project.remove_image('a.png')
    (project.root/'images'/'a.png').write_bytes(b'replacement')
    result=recycle.restore(project,choices(project))
    assert result['count']==0 and result['failed']
    assert (project.root/'images'/'a.png').read_bytes()==b'replacement'
    project.remove_image('a.png')
    records=recycle.inventory(project)
    assert len(records)==2
    latest=next(x for x in records if Path(x['path']).read_bytes()==b'replacement')
    assert recycle.restore(project,{'project_root':str(project.root),'targets':[latest]})['count']==1


def test_model_and_validation_archives_restore(project):
    weights=project.root/'runs'/'train'/'weights';weights.mkdir(parents=True)
    (weights/'best.pt').write_bytes(b'model')
    (project.root/'models'/'local.pt').write_bytes(b'local')
    write_json(project.root/'models'/'local.workflow.json',{'task':'detect'})
    val=project.root/'validation'/'one';val.mkdir(parents=True);write_json(val/'metrics.json',{'map':.9})
    for kind,keys in [('models',['runs/train/weights','models/local.pt']),('validation',['one'])]:archive(project,{'project_root':str(project.root),'kind':kind,'keys':keys})
    assert len(recycle.inventory(project))==3
    assert recycle.restore(project,choices(project))['count']==3
    assert (weights/'best.pt').read_bytes()==b'model' and (val/'metrics.json').exists()
    assert read_json(project.root/'models'/'local.workflow.json')=={'task':'detect'}


def test_permanent_purge_requires_ack_and_revalidates_snapshot(project):
    project.remove_image('a.png');args=choices(project)
    with pytest.raises(ValueError):recycle.purge(project,args)
    source=Path(recycle.inventory(project)[0]['path']);source.write_bytes(b'changed-longer')
    with pytest.raises(ValueError):recycle.purge(project,{**args,'confirm_permanent':True})
    result=recycle.purge(project,{**choices(project),'confirm_permanent':True})
    assert result['count']==1 and not source.exists() and not recycle.inventory(project)
    assert (project.root/'images'/'b.png').exists()


def test_other_root_and_traversal_records_refused(project,tmp_path):
    project.remove_image('a.png');args=choices(project);args['project_root']=str(tmp_path)
    with pytest.raises(ValueError):recycle.restore(project,args)
    write_json(project.root/'removed'/'.entries'/'bad.json',{'mappings':[{'source':'removed/../../outside','destination':'images/hack.png'}]})
    assert len(recycle.inventory(project))==1


@pytest.mark.parametrize('kind',['zip','folder'])
def test_project_transfer_roundtrip_other_user(project,tmp_path,kind):
    video=tmp_path/'外部视频.avi';video.write_bytes(b'source-video')
    write_json(project.root/'videos'/'sequence'/'manifest.json',{'source':str(video),'frames':[]})
    (project.root/'models'/'best.pt').write_bytes(b'weight')
    source=project.root
    original={str(p):digest(p) for p in source.rglob('*') if p.is_file()}
    if kind=='zip':
        source=tmp_path/'项目.zip';result=transfer.export_project(project,{'target':str(source)})
        assert result['files']>0
    target=tmp_path/'用户乙'/'恢复的项目'
    result=transfer.import_project({'source':str(source),'target':str(target)})
    assert result['images']==2 and result['missing_sources']==[]
    assert (target/'models'/'best.pt').read_bytes()==b'weight'
    assert read_json(target/'annotations'/'a.json')['imagePath']==str(target/'images'/'a.png')
    embedded=Path(read_json(target/'videos'/'sequence'/'manifest.json')['source'])
    assert embedded.is_relative_to(target) and embedded.read_bytes()==b'source-video'
    assert all(digest(Path(name))==value for name,value in original.items())
    with pytest.raises(ValueError):transfer.import_project({'source':str(source),'target':str(target)})


def test_transfer_options_recycle_roundtrip_and_missing_video(project,tmp_path):
    project.remove_image('a.png');write_json(project.root/'videos'/'x'/'manifest.json',{'source':str(tmp_path/'missing.avi'),'frames':[]})
    snap=project.root/'datasets'/'snapshot';snap.mkdir(parents=True);(snap/'file').write_bytes(b'snapshot')
    (project.root/'models'/'test.pt').write_bytes(b'weight')
    package=tmp_path/'full.zip'
    transfer.export_project(project,{'target':str(package),'options':{'include_recycle':True,'include_snapshots':False,'include_results':False}})
    target=tmp_path/'received';result=transfer.import_project({'source':str(package),'target':str(target)})
    received=Project(target)
    assert len(result['missing_sources'])==1 and not (target/'models'/'test.pt').exists()
    assert not (target/'datasets'/'snapshot').exists()
    assert recycle.restore(received,choices(received))['count']==1
    assert (target/'images'/'a.png').exists()


@pytest.mark.parametrize('name',['../escape','/absolute','C:/escape','images/../../escape','images/CON.png','images/a:b','images/a.','images/a?b'])
def test_invalid_package_paths_never_escape(project,tmp_path,name):
    package=tmp_path/'bad.zip'
    with zipfile.ZipFile(package,'w') as z:z.writestr('project.json',json.dumps(project.data));z.writestr(name,b'bad')
    target=tmp_path/'new'
    with pytest.raises(ValueError):transfer.import_project({'source':str(package),'target':str(target)})
    assert not target.exists() and not (tmp_path/'escape').exists()


def test_tampered_package_and_duplicate_names_rejected(project,tmp_path):
    package=tmp_path/'good.zip';transfer.export_project(project,{'target':str(package)})
    broken=tmp_path/'broken.zip'
    with zipfile.ZipFile(package) as original,zipfile.ZipFile(broken,'w') as output:
        for item in original.infolist():output.writestr(item,b'corrupt' if item.filename=='images/a.png' else original.read(item))
    with pytest.raises(ValueError,match='校验失败'):transfer.import_project({'source':str(broken),'target':str(tmp_path/'new')})
    with zipfile.ZipFile(tmp_path/'duplicate.zip','w') as z:z.writestr('project.json','{}');z.writestr('Images/A.png',b'a');z.writestr('images/a.PNG',b'b')
    with pytest.raises(ValueError,match='重名'):transfer.import_project({'source':str(tmp_path/'duplicate.zip'),'target':str(tmp_path/'new')})


def test_video_frame_restore_metadata(tmp_path):
    from .test_tracking import setup
    from anylabeling.services.workflow.video_workspace import queue_review,remove_drafts,frame_store
    from anylabeling.services.workflow.tracking import run
    p,_,record,first=setup(tmp_path)
    run(p,{'id':record['id'],'name':first},lambda _:None)
    names=queue_review(p,{'id':record['id']})['names'][:2]
    before={name:digest(frame_store(p).root/'images'/name) for name in names}
    assert remove_drafts(p,{'names':names})['count']==2
    assert recycle.restore(p,choices(p))['count']==2
    manifest=read_json(p.root/'videos'/record['id']/'manifest.json')
    assert all(name in manifest['review_frames'] for name in names)
    assert all(digest(frame_store(p).root/'images'/name)==value for name,value in before.items())


def test_exported_video_remains_trackable_after_zip_transfer(tmp_path):
    from .test_tracking import setup
    from anylabeling.services.workflow.tracking import run
    p,source,record,first=setup(tmp_path)
    before_stamp=source.stat().st_mtime_ns
    package=tmp_path/'video-project.zip';transfer.export_project(p,{'target':str(package)})
    target=tmp_path/'another-user';transfer.import_project({'source':str(package),'target':str(target)})
    imported=Project(target)
    manifest=read_json(target/'videos'/record['id']/'manifest.json')
    assert Path(manifest['source']).stat().st_mtime_ns==before_stamp==manifest['source_mtime_ns']
    assert run(imported,{'id':record['id'],'name':first},lambda _:None)['status']=='completed'


def test_batch_remove_cannot_bypass_recycle(project):
    from anylabeling.services.workflow.desktop import remove_images
    with pytest.raises(ValueError,match='回收站'):remove_images(project,{'project_root':str(project.root),'names':['a.png'],'purge':True,'confirm_permanent':True})
    assert (project.root/'images'/'a.png').exists()


def test_failed_restore_rolls_back_files_and_split_metadata(project):
    project.remove_image('a.png')
    entry=next((project.root/'removed'/'.entries').glob('*.json'))
    data=read_json(entry);data['video_frames']=[{'id':'missing','frames':[]}];write_json(entry,data)
    splits=(project.root/'splits.json').read_bytes()
    result=recycle.restore(project,choices(project))
    assert result['count']==0 and result['failed']
    assert not (project.root/'images'/'a.png').exists() and entry.exists()
    assert (project.root/'splits.json').read_bytes()==splits


def test_zip_symlink_and_output_inside_project_rejected(project,tmp_path):
    package=tmp_path/'link.zip'
    info=zipfile.ZipInfo('images/link');info.create_system=3;info.external_attr=(0o120777<<16)
    with zipfile.ZipFile(package,'w') as z:z.writestr('project.json',json.dumps(project.data));z.writestr(info,'../../outside')
    with pytest.raises(ValueError,match='链接'):transfer.import_project({'source':str(package),'target':str(tmp_path/'new')})
    with pytest.raises(ValueError):transfer.export_project(project,{'target':str(project.root/'unsafe.zip')})
    assert not (project.root/'unsafe.zip').exists()


def test_project_storage_total_includes_unknown_files_and_recycle(project):
    from anylabeling.services.workflow.project_storage import inventory
    (project.root/'custom-folder').mkdir();(project.root/'custom-folder'/'cache.bin').write_bytes(b'extra-data')
    project.remove_image('a.png')
    result=inventory(project)
    actual=[p for p in project.root.rglob('*') if p.is_file()]
    assert result['total_bytes']==sum(p.stat().st_size for p in actual)
    assert result['total_files']==len(actual) and result['incomplete']==[]
    assert sum(row['bytes'] for row in result['usage'])==result['total_bytes']
    assert any(row['key']=='other' and row['bytes']>=len(b'extra-data') for row in result['usage'])
