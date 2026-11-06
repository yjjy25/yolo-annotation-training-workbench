# MaixCAM 导出模式

在“模型转换与量化”选择“MaixCAM / Pro（YOLOv5u / YOLOv8 / YOLO11 / YOLO26 → MaixHub）”，选择 PT，确认宽、高后开始转换。默认宽 320、高 224；每边须为 32 的倍数。模式固定使用 ONNX FP32、opset 17、batch 1、静态输入及 simplify=True。

## 支持的模型

MaixHub 网页转换工具目前支持这四个目标检测家族：

| 家族 | 识别依据（读实际网络层，不看文件名） | 导出参数 |
| --- | --- | --- |
| YOLOv5u | 含 `C3` 模块、`reg_max=16`、无一对一头 | 标准导出，单输出 |
| YOLOv8 | 含 `C2f` 模块、`reg_max=16` | 标准导出，单输出 |
| YOLO11 | 含 `C3k2` 模块、`reg_max=16` | 标准导出，单输出 |
| YOLO26 | 检测头含 `one2one_cv2` / `one2one_cv3`、`reg_max=1` | 额外显式 `nms=False`，保留 one2one 分支 |

- 只支持 Detect（目标检测）。分割、姿态、旋转框和分类会拒绝导出，并提示改用通用模式或按 Sipeed 文档手动转换。
- 只支持 YOLOv5u，不支持旧 `ultralytics/yolov5` 仓库的 YOLOv5 权重。YOLOv5u 是 Ultralytics 的新版 YOLOv5，使用 YOLOv8 的模型检查与后处理代码；旧权重连加载都不成立，需要先换成 YOLOv5u。
- 家族按网络结构识别，改名的权重不会被当成别的家族。检测头不是三个尺度、或 `reg_max` 不是 1/16 的自定义网络会被拒绝。

## 检查内容

导出隔离在 exports 的独立目录，不覆盖源 PT。完成前依次检查：

1. ONNX 结构检查（`onnx.checker`）与固定输入 `1 × 3 × 高 × 宽`。
2. 按家族检查导出结构：
   - YOLO26：六个 one2one Conv 节点 `model.<末层>/one2one_cv(2,3).<尺度>/…/Conv_output_0` 的名称、通道与尺度，输出可为 `[1,300,6]`。
   - YOLOv5u / YOLOv8 / YOLO11：单个输出 `[1, 4+类别数, 锚点数]`，锚点数按 8/16/32 三个步幅与高宽计算（320×224 为 1470）。输出多于一个、NMS 后的 `[1,300,6]`、转置成 `[1, 锚点数, 4+类别数]`、类别通道或锚点数不符都会明确拒绝并说明原因。
3. CPU 推理一次，结果必须全部是有限值。
4. 源权重 SHA256 与转换前一致。

检查通过只代表文件结构与尺寸符合预期；云端量化、板端精度和速度仍需实测。

## 结果与下一步

结果目录包含 `maixcam-<家族>-fp32.onnx`（例如 `maixcam-yolov8-fp32.onnx`、`maixcam-yolo26-fp32.onnx`）、`labels.txt`、`MaixCAM使用说明.md`、`export.json` 和 `export.log`。`export.json` 记录 `maixcam_family`、检查到的节点/输出形状、Ultralytics 版本、参数、源与结果 SHA256。

把 ONNX 上传到 https://maixhub.com/toolbox/convert/maixcam ，模型类型必须选与导出记录一致的家族（YOLOv5u / YOLOv8 / YOLO11 / YOLO26），再选实际板型和正确的标签顺序。准备 20～100 张有代表性的真实图片 ZIP（≤100 MB，不需要标注），完成云端量化后下载 `.mud` 与 `.cvimodel`，一起部署到 MaixCAM / Pro。

## 2026-11-07 实测

用 `.runtime/pretrained` 的权重按本模式参数（`imgsz=224,320`、`opset=17`、`simplify=True`、`dynamic=False`，YOLO26 另加 `nms=False`）实际导出并跑检查，Ultralytics 8.4.178：

| 权重 | 识别 | 导出输出 | 检查 | 文件大小 |
| --- | --- | --- | --- | --- |
| yolov8n.pt | yolov8 / YOLOv8 | `[1, 84, 1470]` | 通过（1 个输出节点） | 12,712,418 |
| yolo11n.pt | yolo11 / YOLO11 | `[1, 84, 1470]` | 通过（1 个输出节点） | 10,602,678 |
| yolo26n.pt | yolo26 / YOLO26 | `[1, 300, 6]` | 通过（6 个 one2one 节点） | 9,803,292 |
| yolov5nu.yaml 转存的随机权重 | yolov5u / YOLOv5u | `[1, 84, 1470]` | 通过（1 个输出节点） | 10,686,663 |

YOLOv5u 用随机权重只验证导出结构与检查逻辑，未训练，不能说明识别效果。以上均未上传 MaixHub、未做云端量化与板端验证；MaixCAM2 需按对应文档适配。

官方文档：https://wiki.sipeed.com/maixpy/doc/zh/ai_model_converter/online_converter.html