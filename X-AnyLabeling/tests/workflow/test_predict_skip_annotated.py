from pathlib import Path
from types import SimpleNamespace
import sys
import pytest
from PIL import Image
from anylabeling.services.workflow.project import Project, write_json, digest, read_json
from anylabeling.services.workflow import predict


def project_with_images(tmp_path, count=6, task='detect'):
    project=Project.create(tmp_path/'项目','skip-test',task,['object'])
    for i in range(count):
        Image.new('RGB',(64,48),(30*i,60,90)).save(project.root/'images'/f'{i}.png')
    return project


def fake_model(monkeypatch, task='detect', during=None):
    calls=[];loads=[]
    class Model:
        names={0:'object'}
        def __init__(self, weights):
            self.task=task;loads.append(weights)
        def predict(self, image, **kwargs):
            calls.append(Path(image).name)
            if during:during(Path(image))
            return [SimpleNamespace(orig_shape=(48,64),boxes=None,probs=SimpleNamespace(top1=0))]
    monkeypatch.setitem(sys.modules,'ultralytics',SimpleNamespace(YOLO=Model))
    return calls,loads


def test_prediction_skips_shapes_reviews_class_flags_and_invalid_labels(tmp_path, monkeypatch, capsys):
    project=project_with_images(tmp_path)
    labels=[{'shapes':[{'label':'object'}],'checked':False}, {'shapes':[],'checked':True}, {'flags':{'object':True}}, {'shapes':[],'flags':{},'checked':False}]
    for i,data in enumerate(labels):write_json(project.annotation(f'{i}.png'),data)
    project.annotation('5.png').write_text('{bad-json',encoding='utf-8')
    existing=project.root/'proposals'/'latest'/'0.json';write_json(existing,{'existing':'preserved'})
    before={p.name:digest(p) for p in (project.root/'annotations').iterdir()};old_candidate=digest(existing)
    calls,_=fake_model(monkeypatch)
    predict.run(project.root,'fixture.pt','cpu',.25)
    assert calls==['3.png','4.png']
    assert {p.name:digest(p) for p in (project.root/'annotations').iterdir()}==before
    assert digest(existing)==old_candidate
    assert {p.name for p in existing.parent.iterdir()}=={'0.json','3.json','4.json'}
    assert '生成 2 张候选，跳过 4 张' in capsys.readouterr().out


def test_all_reviewed_does_not_load_model(tmp_path, monkeypatch, capsys):
    project=project_with_images(tmp_path,count=2)
    for image in project.images:write_json(project.annotation(image),{'checked':True,'shapes':[]})
    calls,loads=fake_model(monkeypatch)
    predict.run(project.root,'unused.pt','cpu',.25)
    assert not calls and not loads
    assert '未加载模型' in capsys.readouterr().out


def test_manual_changes_during_batch_and_inference_are_protected(tmp_path, monkeypatch, capsys):
    project=project_with_images(tmp_path,count=3)
    def during(image):
        if image.name=='0.png':
            write_json(project.annotation('0.png'),{'checked':True,'shapes':[]})
            write_json(project.annotation('1.png'),{'checked':False,'shapes':[{'label':'object'}]})
    calls,_=fake_model(monkeypatch,during=during)
    predict.run(project.root,'fixture.pt','cpu',.25)
    assert calls==['0.png','2.png']
    assert {p.name for p in (project.root/'proposals'/'latest').iterdir()}=={'2.json'}
    assert read_json(project.annotation('0.png'))['checked'] is True
    assert '生成 1 张候选，跳过 2 张' in capsys.readouterr().out


def test_classification_only_predicts_unlabeled_images(tmp_path, monkeypatch):
    project=project_with_images(tmp_path,count=2,task='classify')
    write_json(project.annotation('0.png'),{'flags':{'object':True},'checked':False})
    calls,_=fake_model(monkeypatch,task='classify')
    predict.run(project.root,'fixture.pt','cpu',.25)
    assert calls==['1.png']
    proposal=read_json(project.root/'proposals'/'latest'/'1.json')
    assert proposal['annotation']['flags']=={'object':True}
