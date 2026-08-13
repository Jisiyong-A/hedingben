//! 移植自 scripts/lib/category-inference.mjs —— 本地规则分类。
//! JS 正则均为 case-insensitive（i 标志），Rust 用 (?i) 前缀等价表达。

use regex::Regex;
use serde_json::Value;

struct CategoryRule {
    category: &'static str,
    strong: Vec<Regex>,
    weak: Vec<Regex>,
    tag_boost: Vec<Regex>,
}

fn re(pattern: &str) -> Regex {
    Regex::new(&format!("(?i){pattern}")).unwrap()
}

fn build_rules() -> Vec<CategoryRule> {
    vec![
        CategoryRule {
            category: "编程开发",
            strong: vec![
                re(r"代码|编程|脚本|github|git|api|sdk|node|python|javascript|typescript|终端|terminal|cli|cursor|vscode|debug|仓库|接口|数据库|前端|后端|组件|开源组件|react|next\.js|网页开发"),
            ],
            weak: vec![re(r"开发|部署|工程|函数|自动化脚本|动效组件|网页设计")],
            tag_boost: vec![re(r"前端|后端|开发|编程|代码|组件|开源|网页设计")],
        },
        CategoryRule {
            category: "AI工具",
            strong: vec![
                re(r"claude|openclaw|gpt|llm|aigc|midjourney|sora|comfyui|prompt|提示词|大模型|人工智能|智能体|agent|gemini|claudecode"),
            ],
            weak: vec![re(r"(^|[^a-z])ai([^a-z]|$)"), re(r"工作流|自动化|模型")],
            tag_boost: vec![re(r"AI|agent|openclaw|claudecode|效率神器|智能体|模型")],
        },
        CategoryRule {
            category: "阅读思考",
            strong: vec![
                re(r"读书|阅读|书单|书评|乡土中国|费孝通|卡夫卡|戈多|人类学|社会学|哲学|戏剧|文学|理论|思想|批评|人文社科|荒诞|贝克特"),
            ],
            weak: vec![re(r"认知|思考|概念|文本|语境|经典|作家|研究")],
            tag_boost: vec![re(r"书籍|文学|社会学|哲学|人类学|剧本|卡夫卡|乡土中国|人文社科")],
        },
        CategoryRule {
            category: "设计美学",
            strong: vec![
                re(r"设计|视觉|品牌|排版|字体|海报|审美|ascii|界面|ui|ux|平面|视觉趋势|品牌设计|设计解析|壁画|马赛克艺术"),
            ],
            weak: vec![re(r"美学|视觉流行趋势|风格|色彩")],
            tag_boost: vec![re(r"设计|品牌|视觉|ascii|排版|ui|ux|审美")],
        },
        CategoryRule {
            category: "旅行户外",
            strong: vec![
                re(r"旅行|旅游|徒步|环线|自驾|景点|路线|机票|酒店|露营|city walk|户外|游记|登山|雪山|海拔|香格里拉|腾冲|芒市|川西|冰岛|青海|漠河|阿拉木图|乌孙古道"),
            ],
            weak: vec![re(r"攻略|目的地|出行|行程|打卡")],
            tag_boost: vec![re(r"旅行|旅游|徒步|露营|户外")],
        },
        CategoryRule {
            category: "美食餐饮",
            strong: vec![
                re(r"美食|好吃|餐厅|探店|火锅|菜谱|烹饪|营养|食物|饮食|咖啡|甜品|潮汕|陈晓卿"),
            ],
            weak: vec![re(r"吃|口味|下饭|食材")],
            tag_boost: vec![re(r"美食|咖啡|餐厅|菜谱|探店")],
        },
        CategoryRule {
            category: "影像创作",
            strong: vec![
                re(r"摄影|分镜|电影|镜头|胶片|画面|构图|色彩|视觉叙事|影像|视频剪辑|动画|短片|可灵|veo|海螺|ray2|游戏制作|steam"),
            ],
            weak: vec![re(r"叙事|故事|画幅|拍摄|视频|游戏")],
            tag_boost: vec![re(r"摄影|电影|镜头|影像|分镜|动画|短片|游戏")],
        },
        CategoryRule {
            category: "方法论",
            strong: vec![re(r"方法|步骤|教程|指南|清单|复盘|框架|流程|避坑|经验")],
            weak: vec![re(r"执行|打法|策略")],
            tag_boost: vec![re(r"教程|指南|复盘|方法|框架")],
        },
        CategoryRule {
            category: "生活方式",
            strong: vec![re(r"效率|习惯|时间管理|知识管理|收藏|整理|沉淀|身心|生活方式")],
            weak: vec![re(r"生活|管理|状态")],
            tag_boost: vec![re(r"效率|整理|知识管理|生活方式")],
        },
    ]
}

const CATEGORY_PRIORITY: [&str; 9] = [
    "编程开发",
    "AI工具",
    "阅读思考",
    "设计美学",
    "旅行户外",
    "美食餐饮",
    "影像创作",
    "方法论",
    "生活方式",
];

fn hit_score(text: &str, regs: &[Regex], weight: u32) -> u32 {
    if regs.is_empty() {
        return 0;
    }
    regs.iter().fold(0, |acc, reg| {
        acc + if reg.is_match(text) { weight } else { 0 }
    })
}

pub fn infer_category_from_note(note: &Value) -> String {
    let title = note["title"].as_str().unwrap_or("");
    let content = note["content"].as_str().unwrap_or("");
    let raw_content = note["rawContent"].as_str().unwrap_or("");
    let ocr_text = note["ocrText"].as_str().unwrap_or("");
    let tags = note["tags"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|tag| tag.as_str())
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();

    let source = format!("{title}\n{content}\n{raw_content}\n{ocr_text}\n{tags}");
    let rules = build_rules();
    let mut scores: Vec<(String, u32)> = rules
        .iter()
        .map(|rule| {
            let score = hit_score(&source, &rule.strong, 3)
                + hit_score(&source, &rule.weak, 1)
                + hit_score(&tags, &rule.tag_boost, 2)
                + hit_score(title, &rule.tag_boost, 2);
            (rule.category.to_string(), score)
        })
        .collect();

    let reading = score_of(&scores, "阅读思考");
    let design = score_of(&scores, "设计美学");
    let coding = score_of(&scores, "编程开发");
    let ai = score_of(&scores, "AI工具");

    if reading >= 4 {
        let method_score = score_of(&scores, "方法论").saturating_sub(2);
        set_score(&mut scores, "方法论", method_score);
    }
    if design >= 4 && coding >= 3 {
        set_score(&mut scores, "编程开发", coding + 1);
    }
    let agent_re = re(r"agent|openclaw|claudecode|模型|prompt");
    if ai >= 4 && coding >= 4 && agent_re.is_match(&source) {
        set_score(&mut scores, "AI工具", ai + 1);
    }
    let image_re = re(r"veo|可灵|海螺|动画|短片|视频|镜头|游戏");
    let image_score = score_of(&scores, "影像创作");
    if image_score >= 4 && image_re.is_match(&source) {
        set_score(&mut scores, "影像创作", image_score + 2);
        let ai_score = score_of(&scores, "AI工具").saturating_sub(1);
        set_score(&mut scores, "AI工具", ai_score);
    }

    let mut best_category = "待分类".to_string();
    let mut best_score = 0u32;
    for category in CATEGORY_PRIORITY {
        let score = score_of(&scores, category);
        if score > best_score {
            best_score = score;
            best_category = category.to_string();
        }
    }

    if best_score >= 2 {
        best_category
    } else {
        "待分类".to_string()
    }
}

fn score_of(scores: &[(String, u32)], category: &str) -> u32 {
    scores
        .iter()
        .find(|(name, _)| name == category)
        .map(|(_, score)| *score)
        .unwrap_or(0)
}

fn set_score(scores: &mut [(String, u32)], category: &str, score: u32) {
    if let Some(entry) = scores.iter_mut().find(|(name, _)| name == category) {
        entry.1 = score;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coding_note() {
        let note = json!({
            "title": "用 Rust 重写本地服务",
            "content": "代码仓库、接口设计、前端后端组件开发",
            "tags": ["开发", "编程"],
        });
        assert_eq!(infer_category_from_note(&note), "编程开发");
    }

    #[test]
    fn reading_note() {
        let note = json!({
            "title": "读书笔记：乡土中国",
            "content": "费孝通的人类学与社会学经典，文学批评视角",
            "tags": ["书籍", "文学"],
        });
        assert_eq!(infer_category_from_note(&note), "阅读思考");
    }

    #[test]
    fn travel_note() {
        let note = json!({
            "title": "川西徒步环线攻略",
            "content": "雪山海拔、露营、自驾路线与机票酒店",
            "tags": ["旅行"],
        });
        assert_eq!(infer_category_from_note(&note), "旅行户外");
    }

    #[test]
    fn ai_note() {
        let note = json!({
            "title": "Claude 智能体工作流",
            "content": "大模型 prompt 提示词与自动化",
            "tags": ["AI", "agent"],
        });
        assert_eq!(infer_category_from_note(&note), "AI工具");
    }

    #[test]
    fn unknown_falls_back() {
        let note = json!({
            "title": "普通标题",
            "content": "一些没有明确主题的普通文字内容",
            "tags": [],
        });
        assert_eq!(infer_category_from_note(&note), "待分类");
    }

    #[test]
    fn reading_penalizes_method() {
        // 阅读思考 ≥4 时方法论 -2：含"方法"但阅读强时归阅读
        let note = json!({
            "title": "费孝通的读书方法",
            "content": "阅读思考经典文本的方法论讨论",
            "tags": ["文学", "社会学"],
        });
        let category = infer_category_from_note(&note);
        assert!(category == "阅读思考" || category == "待分类");
    }
}
